/**
 * Search Engine: единая точка поиска. Выбирает первый доступный включённый
 * провайдер, ограничивает результаты, дедуплицирует URL, изолирует ошибки
 * (сбой поиска не должен ломать интервью).
 */
import type { SearchProviderRepository, SearchProviderRecord } from '../db/repo/search.ts';
import { AppError, toAppError } from '../core/errors.ts';
import { log } from '../core/logger.ts';
import type { SearchAdapter, SearchHit, SearchProviderSummary, SearchQuery, SearchResultSet } from './types.ts';
import { tavilyAdapter } from './adapters/tavily.ts';
import { braveAdapter } from './adapters/brave.ts';
import { googleCseAdapter, searxngAdapter, serpApiAdapter, customSearchAdapter } from './adapters/misc.ts';
import { assertSafeUrl } from '../core/ssrf.ts';

const adapters = new Map<string, SearchAdapter>([
  [tavilyAdapter.type, tavilyAdapter],
  [braveAdapter.type, braveAdapter],
  [serpApiAdapter.type, serpApiAdapter],
  [googleCseAdapter.type, googleCseAdapter],
  [searxngAdapter.type, searxngAdapter],
  [customSearchAdapter.type, customSearchAdapter],
]);

export const SEARCH_TYPES = [...adapters.keys()];

export function searchAdapterCatalog(): Array<{
  type: string;
  label: string;
  requiresKey: boolean;
  defaultBaseUrl: string;
}> {
  return [...adapters.values()].map((adapter) => ({
    type: adapter.type,
    label: adapter.label,
    requiresKey: adapter.requiresKey,
    defaultBaseUrl: adapter.defaultBaseUrl,
  }));
}

function getSearchAdapter(type: string): SearchAdapter {
  const adapter = adapters.get(type);
  if (!adapter) {
    throw new AppError('SEARCH_NOT_CONFIGURED', `Неизвестный тип поиска: ${type}`);
  }
  return adapter;
}

export interface SearchEngineOptions {
  allowPrivate?: boolean;
  defaultLimit?: number;
}

export class SearchEngine {
  private readonly providers: SearchProviderRepository;
  private readonly options: SearchEngineOptions;

  constructor(providers: SearchProviderRepository, options: SearchEngineOptions = {}) {
    this.providers = providers;
    this.options = options;
  }

  /** Доступные провайдеры в порядке настройки. */
  available(): SearchProviderSummary[] {
    return this.providers.list().map((provider) => {
      if (!provider.enabled) {
        return {
          providerId: provider.id,
          providerName: provider.name,
          providerType: provider.type,
          available: false,
          reason: 'отключён',
        };
      }
      const adapter = adapters.get(provider.type);
      if (!adapter) {
        return {
          providerId: provider.id,
          providerName: provider.name,
          providerType: provider.type,
          available: false,
          reason: 'неизвестный тип',
        };
      }
      if (adapter.requiresKey && !provider.apiKeyEnc) {
        return {
          providerId: provider.id,
          providerName: provider.name,
          providerType: provider.type,
          available: false,
          reason: 'нет API-ключа',
        };
      }
      return {
        providerId: provider.id,
        providerName: provider.name,
        providerType: provider.type,
        available: true,
        reason: '',
      };
    });
  }

  /**
   * Выполняет поиск. Возвращает результат с полем error, если провайдер
   * недоступен — вызывающая сторона решает, как это отразить.
   */
  async search(query: SearchQuery, providerId?: string): Promise<SearchResultSet> {
    const candidates = providerId
      ? [this.providers.get(providerId)]
      : this.providers.list().filter((provider) => provider.enabled);

    const usable = candidates.find((provider) => {
      const adapter = adapters.get(provider.type);
      return provider.enabled && adapter && (!adapter.requiresKey || provider.apiKeyEnc);
    });

    if (!usable) {
      return {
        providerId: '',
        providerName: '',
        providerType: '',
        query: query.query,
        hits: [],
        durationMs: 0,
        error: 'Поисковый провайдер не настроен',
      };
    }

    return this.runProvider(usable, query);
  }

  private async runProvider(provider: SearchProviderRecord, query: SearchQuery): Promise<SearchResultSet> {
    const started = Date.now();
    const adapter = getSearchAdapter(provider.type);
    const baseUrl = provider.baseUrl || adapter.defaultBaseUrl;

    try {
      if (baseUrl) {
        await assertSafeUrl(baseUrl, this.options.allowPrivate);
      }
      const hits = await adapter.search(
        {
          baseUrl,
          apiKey: provider.apiKeyEnc ? this.providers.apiKey(provider.id) : '',
          options: provider.options,
        },
        { ...query, limit: query.limit ?? this.options.defaultLimit ?? 5 },
      );

      return {
        providerId: provider.id,
        providerName: provider.name,
        providerType: provider.type,
        query: query.query,
        hits: dedupeHits(hits),
        durationMs: Date.now() - started,
      };
    } catch (error) {
      const appError = toAppError(error);
      log.warn('search provider failed', {
        provider: provider.name,
        type: provider.type,
        code: appError.code,
        message: appError.message,
      });
      return {
        providerId: provider.id,
        providerName: provider.name,
        providerType: provider.type,
        query: query.query,
        hits: [],
        durationMs: Date.now() - started,
        error: appError.message,
      };
    }
  }

  /** Есть ли хоть один рабочий провайдер. */
  isConfigured(): boolean {
    return this.available().some((provider) => provider.available);
  }

  /** Поиск по нескольким запросам с ограничением общего числа источников. */
  async searchMany(
    queries: string[],
    options: { limit?: number; totalLimit?: number; language?: string; signal?: AbortSignal } = {},
  ): Promise<{ sets: SearchResultSet[]; hits: SearchHit[] }> {
    const sets: SearchResultSet[] = [];
    const seen = new Set<string>();
    const collected: SearchHit[] = [];
    const totalLimit = options.totalLimit ?? 8;

    for (const query of queries) {
      if (options.signal?.aborted) break;
      if (collected.length >= totalLimit) break;
      const set = await this.search({
        query,
        limit: options.limit ?? 4,
        ...(options.language ? { language: options.language } : {}),
      });
      sets.push(set);
      for (const hit of set.hits) {
        const key = hit.url.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push(hit);
        if (collected.length >= totalLimit) break;
      }
    }

    return { sets, hits: collected };
  }
}

export function dedupeHits(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const hit of hits) {
    const key = hit.url.toLowerCase().replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}
