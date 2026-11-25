/**
 * LLMClient — единственная точка обращения к моделям.
 *
 * Отвечает за: выбор маршрута, безопасное извлечение ключа, повторы только
 * для временных ошибок, резервный маршрут по правилам пользователя, учёт
 * использования, отмену по AbortSignal, запрет утечки секретов в ошибки.
 */
import type { ProviderRepository } from '../db/repo/providers.ts';
import type { RouteRepository } from '../db/repo/routes.ts';
import type { Operation } from '../db/repo/routes.ts';
import type { UsageRepository } from '../db/repo/usage.ts';
import type { SettingsRepository } from '../db/repo/settings.ts';
import { ModelRouter, DEFAULT_PROVIDER_KEY } from './router.ts';
import { getAdapter } from './registry.ts';
import type { LLMCallResult, LLMRequest, ProviderConnection } from './types.ts';
import { AppError, toAppError } from '../core/errors.ts';
import { delay } from '../core/http.ts';
import { log } from '../core/logger.ts';
import { sanitizeCustomHeaders } from './adapters/shared.ts';
import { assertSafeUrlCached } from '../core/urlcache.ts';
import { config } from '../env.ts';

export interface LLMClientOptions {
  providers: ProviderRepository;
  routes: RouteRepository;
  usage: UsageRepository;
  settings: SettingsRepository;
  /** Максимум повторов сверх первой попытки (0 — без повторов). */
  maxRetries?: number;
  /** Базовая задержка экспоненциального backoff. */
  retryBaseMs?: number;
  /** Разрешить приватные/loopback-адреса провайдеров (локальные шлюзы). */
  allowPrivate?: boolean;
}

export interface ClientCallInput {
  operation: Operation;
  messages: LLMRequest['messages'];
  model?: string;
  params?: LLMRequest['params'];
  json?: boolean;
  maxOutputTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  projectId?: string;
  /** Явный провайдер/модель (например, для теста промта). */
  override?: { providerId: string; model: string };
  /** Отключить резервный маршрут для этого вызова. */
  noFallback?: boolean;
}

export class LLMClient {
  readonly router: ModelRouter;
  private readonly options: LLMClientOptions;

  constructor(options: LLMClientOptions) {
    this.options = options;
    this.router = new ModelRouter(options.providers, options.routes, (key) =>
      options.settings.get<string>(key, ''),
    );
  }

  connectionFor(providerId: string): ProviderConnection {
    const provider = this.options.providers.get(providerId);
    return {
      baseUrl: provider.baseUrl.replace(/\/+$/, ''),
      apiKey: this.options.providers.apiKey(providerId),
      protocol: provider.protocol,
      customHeaders: sanitizeCustomHeaders(provider.customHeaders),
      organizationId: provider.organizationId,
      timeoutMs: provider.timeoutMs,
      extra: provider.extra,
    };
  }

  async call(input: ClientCallInput): Promise<LLMCallResult> {
    if (input.override) {
      return this.callWithRoute(input, {
        operation: input.operation,
        providerId: input.override.providerId,
        providerName: this.options.providers.get(input.override.providerId).name,
        providerType: this.options.providers.get(input.override.providerId).type,
        protocol: this.options.providers.get(input.override.providerId).protocol,
        model: input.override.model,
        params: input.params ?? {},
      });
    }

    const resolution = this.router.resolve(input.operation);

    try {
      return await this.callWithRoute(input, resolution);
    } catch (error) {
      const appError = toAppError(error);
      if (input.noFallback || !resolution.fallback || !appError.allowsFallback) throw appError;

      log.warn('primary route failed, switching to fallback', {
        operation: input.operation,
        provider: resolution.providerName,
        code: appError.code,
        fallback: resolution.fallback.providerName,
      });

      const result = await this.callWithRoute(input, {
        operation: input.operation,
        providerId: resolution.fallback.providerId,
        providerName: resolution.fallback.providerName,
        providerType: this.options.providers.get(resolution.fallback.providerId).type,
        protocol: resolution.fallback.protocol,
        model: resolution.fallback.model,
        params: resolution.params,
      });
      return { ...result, route: { ...result.route, fallbackUsed: true } };
    }
  }

  private async callWithRoute(
    input: ClientCallInput,
    resolution: {
      operation: string;
      providerId: string;
      providerName: string;
      providerType: string;
      protocol: string;
      model: string;
      params: LLMRequest['params'];
    },
  ): Promise<LLMCallResult> {
    const adapter = getAdapter(resolution.protocol);
    const connection = this.connectionFor(resolution.providerId);
    const provider = this.options.providers.get(resolution.providerId);

    // Повторная проверка адреса на каждом вызове: DNS мог измениться (rebinding),
    // а провайдера могли отредактировать уже после сохранения.
    await assertSafeUrlCached(
      connection.baseUrl,
      this.options.allowPrivate ?? config.allowPrivateProviders,
    );

    const maxRetries = provider.maxRetries >= 0 ? provider.maxRetries : (this.options.maxRetries ?? 2);
    const baseDelay = this.options.retryBaseMs ?? 700;

    let attempt = 0;
    let lastError: AppError | null = null;

    while (attempt <= maxRetries) {
      if (input.signal?.aborted) throw new AppError('CANCELLED', 'Запрос отменён');
      try {
        const response = await adapter.complete(connection, {
          messages: input.messages,
          model: resolution.model,
          params: { ...resolution.params, ...input.params },
          json: input.json,
          maxOutputTokens: input.maxOutputTokens,
          timeoutMs: input.timeoutMs ?? connection.timeoutMs,
          signal: input.signal,
          operation: input.operation,
        });

        this.options.usage.record({
          projectId: input.projectId,
          operation: input.operation,
          providerId: resolution.providerId,
          providerName: resolution.providerName,
          model: response.model,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          durationMs: response.durationMs,
          status: 'ok',
          retries: attempt,
          fallbackUsed: false,
        });

        return {
          ...response,
          route: {
            providerId: resolution.providerId,
            providerName: resolution.providerName,
            model: response.model,
            fallbackUsed: false,
            retries: attempt,
          },
        };
      } catch (error) {
        const appError = toAppError(error);
        lastError = appError;
        const canRetry = appError.retryable && attempt < maxRetries;
        this.options.usage.record({
          projectId: input.projectId,
          operation: input.operation,
          providerId: resolution.providerId,
          providerName: resolution.providerName,
          model: resolution.model,
          durationMs: 0,
          status: appError.code === 'CANCELLED' ? 'cancelled' : 'error',
          errorCode: appError.code,
          retries: attempt,
          fallbackUsed: false,
        });

        if (!canRetry) break;

        const waitMs = appError.retryAfterMs ?? baseDelay * 2 ** attempt;
        log.warn('llm attempt failed, retrying', {
          operation: input.operation,
          provider: resolution.providerName,
          code: appError.code,
          attempt: attempt + 1,
          waitMs,
        });
        await delay(Math.min(waitMs, 20_000), input.signal);
        attempt++;
      }
    }

    throw lastError ?? new AppError('INTERNAL', 'Не удалось выполнить запрос к модели');
  }

  /** Проверка, что маршрут для операции настроен. */
  assertRoute(operation: Operation): void {
    this.router.resolve(operation);
  }

  defaultProviderId(): string {
    return this.options.settings.get<string>(DEFAULT_PROVIDER_KEY, '');
  }
}
