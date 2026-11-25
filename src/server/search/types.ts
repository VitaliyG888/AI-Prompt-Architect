/** Контракты поисковой подсистемы, независимой от LLM-провайдера. */

export interface SearchQuery {
  query: string;
  /** Язык результатов (ISO 639-1) — подсказка провайдеру. */
  language?: string;
  region?: string;
  limit?: number;
  /** Поиск свежих материалов (дни), если провайдер поддерживает. */
  freshnessDays?: number;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  publisher: string;
  publishedAt: string;
  score: number | null;
  raw?: unknown;
}

export interface SearchResultSet {
  providerId: string;
  providerName: string;
  providerType: string;
  query: string;
  hits: SearchHit[];
  durationMs: number;
  /** Не удалось выполнить поиск (нет ключа, лимит, сеть). */
  error?: string;
}

export interface SearchProviderConnection {
  baseUrl: string;
  apiKey: string;
  options: Record<string, unknown>;
}

export interface SearchAdapter {
  readonly type: string;
  readonly label: string;
  /** Требуется ли API-ключ. */
  readonly requiresKey: boolean;
  readonly defaultBaseUrl: string;
  search(connection: SearchProviderConnection, query: SearchQuery, signal?: AbortSignal): Promise<SearchHit[]>;
}

export interface SearchProviderSummary {
  providerId: string;
  providerName: string;
  providerType: string;
  available: boolean;
  reason: string;
}

export function decodeEntities(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    // Убираем частые трекинг-параметры, чтобы не дублировать источники.
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref|source|yclid)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return raw;
  }
}

export function publisherFromUrl(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
