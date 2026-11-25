/**
 * API конфигурации: LLM-провайдеры, маршрутизация, поисковые провайдеры,
 * параметры генерации, безопасность, использование.
 *
 * Правила безопасности:
 *  - API-ключи никогда не возвращаются; только маска и признак наличия;
 *  - Base URL проверяется на SSRF при сохранении;
 *  - custom headers фильтруются от критических заголовков;
 *  - секреты не попадают в ошибки и логи.
 */
import type { Router } from '../http/router.ts';
import type { ApiDeps } from './helpers.ts';
import { requireOperation } from './helpers.ts';
import { json, readJsonBody, noContent } from '../http/respond.ts';
import {
  asRecord,
  numberInRange,
  optionalEnum,
  optionalString,
  recordOfStrings,
  requireEnum,
  requireString,
} from '../core/validate.ts';
import {
  API_PROTOCOLS,
  PROVIDER_TYPES,
  toPublicProvider,
  type ApiProtocol,
  type ProviderType,
} from '../db/repo/providers.ts';
import { OPERATIONS, OPERATION_LABELS, type Operation } from '../db/repo/routes.ts';
import { SEARCH_TYPES, toPublicSearch, type SearchType } from '../db/repo/search.ts';
import { protocolCatalog, SUPPORTED_PROTOCOLS } from '../llm/registry.ts';
import { searchAdapterCatalog } from '../search/engine.ts';
import { sanitizeCustomHeaders } from '../llm/adapters/shared.ts';
import { validateUrlShape } from '../core/ssrf.ts';
import { AppError } from '../core/errors.ts';
import { DEFAULT_PROVIDER_KEY } from '../llm/router.ts';
import { config } from '../env.ts';
import { clearUrlCache } from '../core/urlcache.ts';

function validateBaseUrl(raw: unknown, field = 'baseUrl'): string {
  const value = requireString(raw, field, { min: 4, max: 500 });
  const shape = validateUrlShape(value);
  if (!shape.ok) throw new AppError('VALIDATION_FAILED', `${field}: ${shape.message}`);
  return value.replace(/\/+$/, '');
}

export function registerConfigRoutes(router: Router, deps: ApiDeps): void {
  const { app } = deps;

  /* ───────────────────────── Каталог возможностей ───────────────────────── */

  router.get('/api/config/catalog', () =>
    json({
      protocols: protocolCatalog(),
      supportedProtocols: SUPPORTED_PROTOCOLS,
      providerTypes: PROVIDER_TYPES,
      apiProtocols: API_PROTOCOLS,
      operations: OPERATIONS.map((operation) => ({ key: operation, label: OPERATION_LABELS[operation] })),
      searchTypes: searchAdapterCatalog(),
      searchProviderTypes: SEARCH_TYPES,
      security: {
        allowPrivateProviders: config.allowPrivateProviders,
        tokenRequired: Boolean(config.appToken),
      },
    }),
  );

  /* ───────────────────────── LLM-провайдеры ───────────────────────── */

  router.get('/api/providers', () =>
    json({
      providers: app.providers.list().map(toPublicProvider),
      defaultProviderId: app.settings.get<string>(DEFAULT_PROVIDER_KEY, ''),
    }),
  );

  router.post('/api/providers', async ({ request }) => {
    const body = await readJsonBody(request);
    const name = requireString(body.name, 'name', { min: 1, max: 80 });
    const type = requireEnum<ProviderType>(body.type, 'type', PROVIDER_TYPES);
    const protocol = requireEnum<ApiProtocol>(body.protocol, 'protocol', API_PROTOCOLS);
    const baseUrl = validateBaseUrl(body.baseUrl);
    const defaultModel = optionalString(body.defaultModel, 'defaultModel', { max: 200 }) ?? '';
    const apiKey = optionalString(body.apiKey, 'apiKey', { max: 400 }) ?? '';
    const customHeaders = sanitizeCustomHeaders(recordOfStrings(body.customHeaders, 'customHeaders'));
    const organizationId = optionalString(body.organizationId, 'organizationId', { max: 200 }) ?? '';
    const timeoutMs = numberInRange(body.timeoutMs, 'timeoutMs', { min: 1000, max: 600000, integer: true }) ?? 120000;
    const maxRetries = numberInRange(body.maxRetries, 'maxRetries', { min: 0, max: 5, integer: true }) ?? 2;

    const provider = app.providers.create({
      name,
      type,
      protocol,
      baseUrl,
      defaultModel,
      apiKey,
      customHeaders,
      organizationId,
      timeoutMs,
      maxRetries,
      enabled: body.enabled !== false,
      extra: body.extra === undefined ? {} : asRecord(body.extra, 'extra'),
    });

    clearUrlCache();
    return json({ provider: toPublicProvider(provider) }, 201);
  });

  router.patch('/api/providers/:id', async ({ params, request }) => {
    app.providers.get(params.id);
    const body = await readJsonBody(request);

    // apiKey: undefined — не менять; null или '' — удалить ключ.
    let apiKey: string | null | undefined;
    if (body.apiKey === null) apiKey = null;
    else if (typeof body.apiKey === 'string') apiKey = body.apiKey.trim() === '' ? null : body.apiKey.trim();
    else if (body.clearApiKey === true) apiKey = null;

    const provider = app.providers.update(params.id, {
      ...(body.name !== undefined ? { name: requireString(body.name, 'name', { min: 1, max: 80 }) } : {}),
      ...(body.type !== undefined ? { type: requireEnum<ProviderType>(body.type, 'type', PROVIDER_TYPES) } : {}),
      ...(body.protocol !== undefined
        ? { protocol: requireEnum<ApiProtocol>(body.protocol, 'protocol', API_PROTOCOLS) }
        : {}),
      ...(body.baseUrl !== undefined ? { baseUrl: validateBaseUrl(body.baseUrl) } : {}),
      ...(body.defaultModel !== undefined
        ? { defaultModel: optionalString(body.defaultModel, 'defaultModel', { max: 200 }) ?? '' }
        : {}),
      ...(body.customHeaders !== undefined
        ? { customHeaders: sanitizeCustomHeaders(recordOfStrings(body.customHeaders, 'customHeaders')) }
        : {}),
      ...(body.organizationId !== undefined
        ? { organizationId: optionalString(body.organizationId, 'organizationId', { max: 200 }) ?? '' }
        : {}),
      ...(body.timeoutMs !== undefined
        ? {
            timeoutMs:
              numberInRange(body.timeoutMs, 'timeoutMs', { min: 1000, max: 600000, integer: true }) ?? 120000,
          }
        : {}),
      ...(body.maxRetries !== undefined
        ? { maxRetries: numberInRange(body.maxRetries, 'maxRetries', { min: 0, max: 5, integer: true }) ?? 2 }
        : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled === true } : {}),
      ...(body.extra !== undefined ? { extra: asRecord(body.extra, 'extra') } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
    });

    clearUrlCache();
    return json({ provider: toPublicProvider(provider) });
  });

  router.delete('/api/providers/:id', ({ params }) => {
    app.providers.remove(params.id);
    if (app.settings.get<string>(DEFAULT_PROVIDER_KEY, '') === params.id) {
      app.settings.set(DEFAULT_PROVIDER_KEY, '');
    }
    clearUrlCache();
    return noContent();
  });

  router.post('/api/providers/:id/default', ({ params }) => {
    app.providers.get(params.id);
    app.settings.set(DEFAULT_PROVIDER_KEY, params.id);
    return json({ defaultProviderId: params.id });
  });

  /** Проверка подключения сохранённого провайдера. */
  router.post('/api/providers/:id/test', async ({ params, request }) => {
    app.providers.get(params.id);
    const body = request.headers.get('content-type')?.includes('application/json') ? await readJsonBody(request) : {};
    const model = optionalString(body.model, 'model', { max: 200 });
    const result = await app.connectionTester.test({ providerId: params.id, model });
    return json(result);
  });

  /** Проверка «черновика» до сохранения провайдера. */
  router.post('/api/providers/test', async ({ request }) => {
    const body = await readJsonBody(request);
    const draft = asRecord(body.draft ?? body, 'draft');
    const protocol = requireEnum<ApiProtocol>(draft.protocol, 'protocol', API_PROTOCOLS);
    const baseUrl = validateBaseUrl(draft.baseUrl);
    const result = await app.connectionTester.test({
      draft: {
        protocol,
        baseUrl,
        apiKey: optionalString(draft.apiKey, 'apiKey', { max: 400 }) ?? '',
        model: optionalString(draft.model ?? draft.defaultModel, 'model', { max: 200 }) ?? '',
        customHeaders: sanitizeCustomHeaders(recordOfStrings(draft.customHeaders, 'customHeaders')),
        organizationId: optionalString(draft.organizationId, 'organizationId', { max: 200 }) ?? '',
        timeoutMs: numberInRange(draft.timeoutMs, 'timeoutMs', { min: 1000, max: 600000, integer: true }) ?? 60000,
        extra: draft.extra === undefined ? {} : asRecord(draft.extra, 'extra'),
      },
    });
    return json(result);
  });

  /** Список моделей провайдера (ручной ввод остаётся всегда доступен). */
  router.get('/api/providers/:id/models', async ({ params }) => {
    const provider = app.providers.get(params.id);
    const { getAdapter } = await import('../llm/registry.ts');
    const adapter = getAdapter(provider.protocol);
    if (!adapter.listModels) {
      return json({ models: [], supported: false, message: 'Протокол не поддерживает список моделей' });
    }
    try {
      const models = await adapter.listModels(app.client.connectionFor(provider.id));
      return json({ models, supported: true });
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError('UPSTREAM_ERROR', String(error));
      return json({
        models: [],
        supported: true,
        message: `${appError.message}. Введите Model ID вручную.`,
      });
    }
  });

  /* ───────────────────────── Маршрутизация операций ───────────────────────── */

  router.get('/api/routes', () =>
    json({
      routes: app.routes.list(),
      defaultProviderId: app.settings.get<string>(DEFAULT_PROVIDER_KEY, ''),
      operations: OPERATIONS.map((operation) => ({ key: operation, label: OPERATION_LABELS[operation] })),
    }),
  );

  router.put('/api/routes/:operation', async ({ params, request }) => {
    const operation = requireOperation(params.operation, OPERATIONS);
    const body = await readJsonBody(request);

    const providerId =
      body.providerId === null || body.providerId === ''
        ? null
        : optionalString(body.providerId, 'providerId', { max: 60 }) ?? null;
    if (providerId) app.providers.get(providerId);

    const fallbackProviderId =
      body.fallbackProviderId === null || body.fallbackProviderId === ''
        ? null
        : optionalString(body.fallbackProviderId, 'fallbackProviderId', { max: 60 }) ?? null;
    if (fallbackProviderId) app.providers.get(fallbackProviderId);

    const paramsInput = body.params === undefined ? {} : asRecord(body.params, 'params');
    const generationParams = {
      temperature: numberInRange(paramsInput.temperature, 'params.temperature', { min: 0, max: 2 }),
      topP: numberInRange(paramsInput.topP, 'params.topP', { min: 0, max: 1 }),
      maxOutputTokens: numberInRange(paramsInput.maxOutputTokens, 'params.maxOutputTokens', {
        min: 1,
        max: 200000,
        integer: true,
      }),
      frequencyPenalty: numberInRange(paramsInput.frequencyPenalty, 'params.frequencyPenalty', { min: -2, max: 2 }),
      presencePenalty: numberInRange(paramsInput.presencePenalty, 'params.presencePenalty', { min: -2, max: 2 }),
      seed: numberInRange(paramsInput.seed, 'params.seed', { min: 0, max: 2 ** 31, integer: true }),
      reasoningEffort: optionalEnum(paramsInput.reasoningEffort, 'params.reasoningEffort', [
        'low',
        'medium',
        'high',
      ] as const),
    };
    for (const key of Object.keys(generationParams) as Array<keyof typeof generationParams>) {
      if (generationParams[key] === undefined) delete generationParams[key];
    }

    const route = app.routes.upsert(operation, {
      providerId,
      model: optionalString(body.model, 'model', { max: 200 }) ?? '',
      params: generationParams,
      fallbackProviderId,
      fallbackModel: optionalString(body.fallbackModel, 'fallbackModel', { max: 200 }) ?? '',
      useFallback: body.useFallback === true,
    });

    return json({ route });
  });

  router.delete('/api/routes/:operation', ({ params }) => {
    const operation = requireOperation(params.operation, OPERATIONS);
    app.routes.remove(operation);
    return noContent();
  });

  /* ───────────────────────── Поисковые провайдеры ───────────────────────── */

  router.get('/api/search-providers', () =>
    json({
      providers: app.searchProviders.list().map(toPublicSearch),
      status: app.search.available(),
      configured: app.search.isConfigured(),
      types: searchAdapterCatalog(),
    }),
  );

  router.post('/api/search-providers', async ({ request }) => {
    const body = await readJsonBody(request);
    const name = requireString(body.name, 'name', { min: 1, max: 80 });
    const type = requireEnum<SearchType>(body.type, 'type', SEARCH_TYPES);
    const baseUrl = optionalString(body.baseUrl, 'baseUrl', { max: 500 }) ?? '';
    if (baseUrl) {
      const shape = validateUrlShape(baseUrl);
      if (!shape.ok) throw new AppError('VALIDATION_FAILED', `baseUrl: ${shape.message}`);
    }
    const provider = app.searchProviders.create({
      name,
      type,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKey: optionalString(body.apiKey, 'apiKey', { max: 400 }) ?? '',
      options: body.options === undefined ? {} : asRecord(body.options, 'options'),
      enabled: body.enabled !== false,
    });
    clearUrlCache();
    return json({ provider: toPublicSearch(provider) }, 201);
  });

  router.patch('/api/search-providers/:id', async ({ params, request }) => {
    app.searchProviders.get(params.id);
    const body = await readJsonBody(request);
    let apiKey: string | null | undefined;
    if (body.apiKey === null || body.clearApiKey === true) apiKey = null;
    else if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') apiKey = body.apiKey.trim();

    const baseUrl = body.baseUrl !== undefined ? optionalString(body.baseUrl, 'baseUrl', { max: 500 }) ?? '' : undefined;
    if (baseUrl) {
      const shape = validateUrlShape(baseUrl);
      if (!shape.ok) throw new AppError('VALIDATION_FAILED', `baseUrl: ${shape.message}`);
    }

    const provider = app.searchProviders.update(params.id, {
      ...(body.name !== undefined ? { name: requireString(body.name, 'name', { min: 1, max: 80 }) } : {}),
      ...(body.type !== undefined ? { type: requireEnum<SearchType>(body.type, 'type', SEARCH_TYPES) } : {}),
      ...(baseUrl !== undefined ? { baseUrl: baseUrl.replace(/\/+$/, '') } : {}),
      ...(body.options !== undefined ? { options: asRecord(body.options, 'options') } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled === true } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
    });
    clearUrlCache();
    return json({ provider: toPublicSearch(provider) });
  });

  router.delete('/api/search-providers/:id', ({ params }) => {
    app.searchProviders.remove(params.id);
    clearUrlCache();
    return noContent();
  });

  /** Пробный поиск: показывает реальные результаты или честную ошибку. */
  router.post('/api/search-providers/:id/test', async ({ params, request }) => {
    app.searchProviders.get(params.id);
    const body = request.headers.get('content-type')?.includes('application/json') ? await readJsonBody(request) : {};
    const query = optionalString(body.query, 'query', { max: 300 }) ?? 'prompt engineering best practices';
    const result = await app.search.search({ query, limit: 3 }, params.id);
    return json(result);
  });

  /* ───────────────────────── Настройки и использование ───────────────────────── */

  router.get('/api/settings', () =>
    json({
      defaults: app.settings.defaults(),
      raw: app.settings.getAll(),
      security: {
        allowPrivateProviders: config.allowPrivateProviders,
        tokenRequired: Boolean(config.appToken),
        masterKeyFromEnv: Boolean(config.masterKey),
      },
      version: config.version,
    }),
  );

  router.put('/api/settings/defaults', async ({ request }) => {
    const body = await readJsonBody(request);
    const defaults = app.settings.saveDefaults({
      ...(body.mode !== undefined
        ? { mode: requireEnum(body.mode, 'mode', ['quick', 'professional', 'expert'] as const) }
        : {}),
      ...(body.language !== undefined ? { language: requireString(body.language, 'language', { min: 2, max: 8 }) } : {}),
      ...(body.researchEnabled !== undefined ? { researchEnabled: body.researchEnabled === true } : {}),
      ...(body.maxSourcesPerSection !== undefined
        ? {
            maxSourcesPerSection:
              numberInRange(body.maxSourcesPerSection, 'maxSourcesPerSection', {
                min: 1,
                max: 10,
                integer: true,
              }) ?? 4,
          }
        : {}),
      ...(body.qualityThreshold !== undefined
        ? {
            qualityThreshold:
              numberInRange(body.qualityThreshold, 'qualityThreshold', { min: 0, max: 100, integer: true }) ?? 80,
          }
        : {}),
      ...(body.autoTest !== undefined ? { autoTest: body.autoTest === true } : {}),
    });
    return json({ defaults });
  });

  router.get('/api/usage', ({ query }) => {
    const since = query.get('since') ?? undefined;
    return json({
      summary: app.usage.summary(since),
      events: app.usage.list(100),
    });
  });

  /** Сводка состояния для панели «Готовность». */
  router.get('/api/health', () => {
    const providers = app.providers.list();
    const enabledProviders = providers.filter((provider) => provider.enabled);
    return json({
      ok: true,
      version: config.version,
      providers: { total: providers.length, enabled: enabledProviders.length },
      search: { configured: app.search.isConfigured(), providers: app.search.available() },
      projects: app.projects.count(),
      routes: app.routes.list().length,
      security: {
        allowPrivateProviders: config.allowPrivateProviders,
        tokenRequired: Boolean(config.appToken),
      },
    });
  });
}
