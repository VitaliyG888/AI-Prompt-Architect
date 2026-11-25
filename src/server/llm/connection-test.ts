/**
 * Connection Tester: пошаговая проверка подключения провайдера.
 *
 * Шаги: формат URL → доступность endpoint → аутентификация → список
 * моделей (если поддерживается) → тестовый запрос → разбор ответа.
 * Секреты не попадают в результат проверки и в логи.
 */
import type { ProviderRepository } from '../db/repo/providers.ts';
import type { ProviderRecord } from '../db/repo/providers.ts';
import { getAdapter } from './registry.ts';
import { assertSafeUrl, validateUrlShape } from '../core/ssrf.ts';
import { AppError, toAppError } from '../core/errors.ts';
import { sanitizeCustomHeaders } from './adapters/shared.ts';
import type { ProviderConnection } from './types.ts';

export type ConnectionStatus =
  | 'connected'
  | 'authentication_failed'
  | 'endpoint_unavailable'
  | 'model_not_found'
  | 'unsupported_protocol'
  | 'request_timeout'
  | 'rate_limit'
  | 'unknown_error';

export interface ConnectionStep {
  name: string;
  status: 'ok' | 'failed' | 'skipped';
  message: string;
  durationMs: number;
}

export interface ConnectionTestResult {
  status: ConnectionStatus;
  summary: string;
  steps: ConnectionStep[];
  models: Array<{ id: string; label?: string }>;
  modelUsed: string;
  reply?: string;
  checkedAt: string;
}

function toStatus(error: AppError): ConnectionStatus {
  switch (error.code) {
    case 'PROVIDER_AUTH_FAILED':
      return 'authentication_failed';
    case 'PROVIDER_UNAVAILABLE':
      return 'endpoint_unavailable';
    case 'MODEL_NOT_FOUND':
      return 'model_not_found';
    case 'UNSUPPORTED_PROTOCOL':
    case 'UNSUPPORTED_FEATURE':
      return 'unsupported_protocol';
    case 'REQUEST_TIMEOUT':
      return 'request_timeout';
    case 'RATE_LIMITED':
      return 'rate_limit';
    default:
      return 'unknown_error';
  }
}

const SUMMARIES: Record<ConnectionStatus, string> = {
  connected: 'Connected — подключение работает, модель отвечает',
  authentication_failed: 'Authentication Failed — ключ отклонён провайдером',
  endpoint_unavailable: 'Endpoint Unavailable — endpoint недоступен',
  model_not_found: 'Model Not Found — endpoint или модель не найдены',
  unsupported_protocol: 'Unsupported Protocol — протокол или функция не поддерживается',
  request_timeout: 'Request Timeout — истекло время ожидания',
  rate_limit: 'Rate Limit — превышен лимит запросов',
  unknown_error: 'Unknown Error — не удалось определить причину',
};

export interface TestConnectionInput {
  providerId?: string;
  /** Проверка «черновика» до сохранения. */
  draft?: {
    protocol: string;
    baseUrl: string;
    apiKey?: string;
    model: string;
    customHeaders?: Record<string, string>;
    organizationId?: string;
    timeoutMs?: number;
    extra?: Record<string, unknown>;
  };
  model?: string;
  allowPrivate?: boolean;
}

export interface ConnectionTesterOptions {
  /** Разрешить loopback/приватные адреса (локальные шлюзы, mock-серверы). */
  allowPrivate?: boolean;
}

export class ConnectionTester {
  private readonly providers: ProviderRepository;
  private readonly options: ConnectionTesterOptions;

  constructor(providers: ProviderRepository, options: ConnectionTesterOptions = {}) {
    this.providers = providers;
    this.options = options;
  }

  async test(input: TestConnectionInput): Promise<ConnectionTestResult> {
    const steps: ConnectionStep[] = [];
    const checkedAt = new Date().toISOString();
    let provider: ProviderRecord | null = null;
    let connection: ProviderConnection;
    let model: string;

    if (input.draft) {
      const draft = input.draft;
      connection = {
        baseUrl: draft.baseUrl.replace(/\/+$/, ''),
        apiKey: draft.apiKey ?? '',
        protocol: draft.protocol,
        customHeaders: sanitizeCustomHeaders(draft.customHeaders ?? {}),
        organizationId: draft.organizationId ?? '',
        timeoutMs: draft.timeoutMs ?? 120_000,
        extra: draft.extra ?? {},
      };
      model = (input.model ?? draft.model).trim();
    } else {
      if (!input.providerId) {
        throw new AppError('VALIDATION_FAILED', 'Укажите providerId или draft-конфигурацию');
      }
      provider = this.providers.get(input.providerId);
      connection = {
        baseUrl: provider.baseUrl.replace(/\/+$/, ''),
        apiKey: this.providers.apiKey(provider.id),
        protocol: provider.protocol,
        customHeaders: sanitizeCustomHeaders(provider.customHeaders),
        organizationId: provider.organizationId,
        timeoutMs: provider.timeoutMs,
        extra: provider.extra,
      };
      model = (input.model || provider.defaultModel).trim();
    }

    const done = (status: ConnectionStatus, reply?: string): ConnectionTestResult => {
      const result: ConnectionTestResult = {
        status,
        summary: SUMMARIES[status],
        steps,
        models: [],
        modelUsed: model,
        ...(reply ? { reply } : {}),
        checkedAt,
      };
      if (provider) {
        this.providers.setLastCheck(provider.id, {
          status,
          checkedAt,
          model,
          summary: result.summary,
        });
      }
      return result;
    };

    // 1. Формат URL
    const started1 = Date.now();
    const shape = validateUrlShape(connection.baseUrl);
    if (!shape.ok) {
      steps.push({
        name: 'URL format',
        status: 'failed',
        message: shape.message,
        durationMs: Date.now() - started1,
      });
      return done('endpoint_unavailable');
    }
    steps.push({ name: 'URL format', status: 'ok', message: 'URL корректен', durationMs: Date.now() - started1 });

    // 2. Адаптер протокола
    let adapter;
    try {
      adapter = getAdapter(connection.protocol);
      steps.push({
        name: 'Protocol',
        status: 'ok',
        message: `Адаптер: ${adapter.label}`,
        durationMs: 0,
      });
    } catch (error) {
      const appError = toAppError(error);
      steps.push({ name: 'Protocol', status: 'failed', message: appError.message, durationMs: 0 });
      return done('unsupported_protocol');
    }

    // 3. SSRF-проверка и доступность
    const started3 = Date.now();
    try {
      await assertSafeUrl(connection.baseUrl, input.allowPrivate ?? this.options.allowPrivate);
      steps.push({
        name: 'Endpoint safety',
        status: 'ok',
        message: 'Адрес прошёл проверку SSRF',
        durationMs: Date.now() - started3,
      });
    } catch (error) {
      const appError = toAppError(error);
      steps.push({
        name: 'Endpoint safety',
        status: 'failed',
        message: appError.message,
        durationMs: Date.now() - started3,
      });
      return done(appError.code === 'BLOCKED_URL' ? 'endpoint_unavailable' : toStatus(appError));
    }

    // 4. Список моделей (не критично)
    let models: Array<{ id: string; label?: string }> = [];
    if (adapter.capabilities.modelListing && adapter.listModels) {
      const started4 = Date.now();
      try {
        models = (await adapter.listModels(connection)).map((item) => ({
          id: item.id,
          ...(item.label ? { label: item.label } : {}),
        }));
        steps.push({
          name: 'Model listing',
          status: 'ok',
          message: `Получено моделей: ${models.length}`,
          durationMs: Date.now() - started4,
        });
      } catch (error) {
        const appError = toAppError(error);
        steps.push({
          name: 'Model listing',
          status: 'skipped',
          message: `Список моделей недоступен (${appError.code}). Ручной ввод Model ID остаётся доступен.`,
          durationMs: Date.now() - started4,
        });
      }
    } else {
      steps.push({
        name: 'Model listing',
        status: 'skipped',
        message: 'Протокол не поддерживает автоматический список моделей',
        durationMs: 0,
      });
    }

    // 5. Тестовый запрос
    if (!model) {
      steps.push({
        name: 'Test request',
        status: 'skipped',
        message: 'Model ID не указан — тестовый запрос пропущен',
        durationMs: 0,
      });
      return { ...done('model_not_found'), models };
    }

    const started5 = Date.now();
    try {
      const response = await adapter.complete(connection, {
        model,
        messages: [
          {
            role: 'user',
            content: 'Reply with exactly one word: OK',
          },
        ],
        params: { temperature: 0, maxOutputTokens: 16 },
        timeoutMs: Math.min(connection.timeoutMs, 60_000),
      });
      steps.push({
        name: 'Test request',
        status: 'ok',
        message: `Модель ответила (${response.usage.outputTokens} выходных токенов)`,
        durationMs: Date.now() - started5,
      });
      return { ...done('connected', response.text.slice(0, 200)), models };
    } catch (error) {
      const appError = toAppError(error);
      steps.push({
        name: 'Test request',
        status: 'failed',
        message: appError.message,
        durationMs: Date.now() - started5,
      });
      return { ...done(toStatus(appError)), models };
    }
  }
}
