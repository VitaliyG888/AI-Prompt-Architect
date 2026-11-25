/**
 * Model Router: выбирает провайдера и модель для операции.
 *
 * Приоритет: индивидуальная настройка операции → провайдер по умолчанию →
 * первый включённый провайдер. Пустая модель у маршрута означает
 * default_model провайдера. Наследование явное и предсказуемое.
 */
import type { RouteRepository } from '../db/repo/routes.ts';
import type { ProviderRepository, ProviderRecord } from '../db/repo/providers.ts';
import type { Operation } from '../db/repo/routes.ts';
import type { GenerationParams, RouteResolution } from './types.ts';
import { AppError } from '../core/errors.ts';

export const DEFAULT_PROVIDER_KEY = 'default_provider_id';

export class ModelRouter {
  private readonly providers: ProviderRepository;
  private readonly routes: RouteRepository;
  private readonly getSetting: (key: string) => string;

  constructor(
    providers: ProviderRepository,
    routes: RouteRepository,
    getSetting: (key: string) => string,
  ) {
    this.providers = providers;
    this.routes = routes;
    this.getSetting = getSetting;
  }

  private defaultProvider(): ProviderRecord | null {
    const id = this.getSetting(DEFAULT_PROVIDER_KEY);
    if (id) {
      const provider = this.providers.find(id);
      if (provider && provider.enabled) return provider;
    }
    return this.providers.list().find((provider) => provider.enabled) ?? null;
  }

  private requireProvider(id: string | null, operation: string): ProviderRecord {
    if (id) {
      const provider = this.providers.find(id);
      if (!provider) {
        throw new AppError('PROVIDER_NOT_CONFIGURED', `Маршрут "${operation}" ссылается на удалённого провайдера`);
      }
      if (!provider.enabled) {
        throw new AppError('PROVIDER_NOT_CONFIGURED', `Провайдер "${provider.name}" отключён`);
      }
      return provider;
    }
    const fallback = this.defaultProvider();
    if (!fallback) {
      throw new AppError(
        'PROVIDER_NOT_CONFIGURED',
        'Не настроен ни один LLM-провайдер. Добавьте провайдера в Settings → AI Providers',
      );
    }
    return fallback;
  }

  resolve(operation: Operation): RouteResolution {
    const route = this.routes.get(operation);
    const provider = this.requireProvider(route?.providerId ?? null, operation);

    const model = (route?.model ?? '').trim() || provider.defaultModel;
    if (!model) {
      throw new AppError(
        'MODEL_NOT_FOUND',
        `Не выбрана модель для операции "${operation}" и нет модели по умолчанию у провайдера "${provider.name}"`,
      );
    }

    const params: GenerationParams = route?.params ?? {};
    let fallback: RouteResolution['fallback'];

    if (route?.useFallback && route.fallbackProviderId && route.fallbackProviderId !== provider.id) {
      const fbProvider = this.providers.find(route.fallbackProviderId);
      if (fbProvider && fbProvider.enabled) {
        const fbModel = route.fallbackModel.trim() || fbProvider.defaultModel;
        if (fbModel) {
          fallback = {
            providerId: fbProvider.id,
            providerName: fbProvider.name,
            protocol: fbProvider.protocol,
            model: fbModel,
          };
        }
      }
    }

    return {
      operation,
      providerId: provider.id,
      providerName: provider.name,
      providerType: provider.type,
      protocol: provider.protocol,
      model,
      params,
      ...(fallback ? { fallback } : {}),
    };
  }

  /** Снимок маршрутизации для сохранения в проекте (без секретов). */
  snapshot(): Record<string, unknown> {
    const providers = this.providers.list().map((provider) => ({
      id: provider.id,
      name: provider.name,
      type: provider.type,
      protocol: provider.protocol,
      defaultModel: provider.defaultModel,
    }));
    const routes = this.routes.list().map((route) => ({
      operation: route.operation,
      providerId: route.providerId,
      model: route.model,
      fallbackProviderId: route.fallbackProviderId,
      fallbackModel: route.fallbackModel,
      useFallback: route.useFallback,
    }));
    return { providers, routes, capturedAt: new Date().toISOString() };
  }
}
