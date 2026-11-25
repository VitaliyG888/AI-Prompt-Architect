/** Адаптеры SerpAPI, Google CSE, SearXNG и произвольного JSON-поиска. */
import { httpJson } from '../../core/http.ts';
import { AppError } from '../../core/errors.ts';
import { publisherFromUrl, normalizeUrl, type SearchAdapter, type SearchHit } from '../types.ts';

interface SerpApiResponse {
  organic_results?: Array<{
    title?: string;
    link?: string;
    snippet?: string;
    date?: string;
    position?: number;
  }>;
}

export const serpApiAdapter: SearchAdapter = {
  type: 'serpapi',
  label: 'SerpAPI',
  requiresKey: true,
  defaultBaseUrl: 'https://serpapi.com',
  async search(connection, query, signal) {
    if (!connection.apiKey) throw new AppError('SEARCH_NOT_CONFIGURED', 'SerpAPI требует API-ключ');
    const base = connection.baseUrl || 'https://serpapi.com';
    const params = new URLSearchParams({
      q: query.query,
      api_key: connection.apiKey,
      num: String(Math.min(query.limit ?? 5, 20)),
      engine: String(connection.options.engine ?? 'google'),
    });
    if (query.language) params.set('hl', query.language);
    if (query.region) params.set('gl', query.region.toLowerCase());

    const { data } = await httpJson<SerpApiResponse>(`${base}/search.json?${params.toString()}`, {
      method: 'GET',
      timeoutMs: 40_000,
      signal,
      label: 'SerpAPI',
    });

    return (data.organic_results ?? [])
      .filter(
        (item): item is { link: string; title?: string; snippet?: string; date?: string; position?: number } =>
          typeof item.link === 'string',
      )
      .map<SearchHit>((item) => ({
        title: item.title?.trim() || item.link,
        url: normalizeUrl(item.link),
        snippet: (item.snippet ?? '').slice(0, 1200),
        publisher: publisherFromUrl(item.link),
        publishedAt: item.date ?? '',
        score: typeof item.position === 'number' ? Math.max(0, 1 - item.position / 30) : null,
      }));
  },
};

interface GoogleCseResponse {
  items?: Array<{
    title?: string;
    link?: string;
    snippet?: string;
  }>;
}

export const googleCseAdapter: SearchAdapter = {
  type: 'google-cse',
  label: 'Google Programmable Search',
  requiresKey: true,
  defaultBaseUrl: 'https://www.googleapis.com/customsearch/v1',
  async search(connection, query, signal) {
    if (!connection.apiKey) throw new AppError('SEARCH_NOT_CONFIGURED', 'Google CSE требует API-ключ');
    const cx = String(connection.options.cx ?? '');
    if (!cx) throw new AppError('SEARCH_NOT_CONFIGURED', 'Google CSE требует параметр cx (ID поисковой системы)');

    const params = new URLSearchParams({
      key: connection.apiKey,
      cx,
      q: query.query,
      num: String(Math.min(query.limit ?? 5, 10)),
    });
    if (query.language) params.set('hl', query.language);

    // Base URL может быть указан как корнем API, так и полным путём до метода:
    // нельзя дописывать /customsearch/v1 дважды.
    const base = (connection.baseUrl || 'https://www.googleapis.com/customsearch/v1').replace(/\/+$/, '');
    const endpoint = /\/customsearch(\/v1)?$/.test(base) ? base : `${base}/customsearch/v1`;

    const { data } = await httpJson<GoogleCseResponse>(`${endpoint}?${params.toString()}`, {
      method: 'GET',
      timeoutMs: 30_000,
      signal,
      label: 'Google CSE',
    });

    return (data.items ?? [])
      .filter((item): item is { link: string; title?: string; snippet?: string } => typeof item.link === 'string')
      .map<SearchHit>((item) => ({
        title: item.title?.trim() || item.link,
        url: normalizeUrl(item.link),
        snippet: (item.snippet ?? '').slice(0, 1200),
        publisher: publisherFromUrl(item.link),
        publishedAt: '',
        score: null,
      }));
  },
};

interface SearxResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    publishedDate?: string;
    score?: number;
    engine?: string;
  }>;
}

export const searxngAdapter: SearchAdapter = {
  type: 'searxng',
  label: 'SearXNG',
  requiresKey: false,
  defaultBaseUrl: 'http://127.0.0.1:8080',
  async search(connection, query, signal) {
    const base = (connection.baseUrl || 'http://127.0.0.1:8080').replace(/\/+$/, '');
    const params = new URLSearchParams({
      q: query.query,
      format: 'json',
      safesearch: String(connection.options.safeSearch ?? 0),
      ...(query.language ? { language: query.language } : {}),
    });

    const { data } = await httpJson<SearxResponse>(`${base}/search?${params.toString()}`, {
      method: 'GET',
      headers: connection.apiKey ? { authorization: `Bearer ${connection.apiKey}` } : {},
      timeoutMs: 30_000,
      signal,
      label: 'SearXNG',
    });

    return (data.results ?? [])
      .filter(
        (item): item is { url: string; title?: string; content?: string; publishedDate?: string; score?: number } =>
          typeof item.url === 'string',
      )
      .slice(0, query.limit ?? 5)
      .map<SearchHit>((item) => ({
        title: item.title?.trim() || item.url,
        url: normalizeUrl(item.url),
        snippet: (item.content ?? '').slice(0, 1200),
        publisher: publisherFromUrl(item.url),
        publishedAt: item.publishedDate ?? '',
        score: typeof item.score === 'number' ? item.score : null,
      }));
  },
};

interface CustomResponse {
  results?: Array<{ title?: string; url?: string; link?: string; snippet?: string; description?: string }>;
}

/**
 * Произвольный поисковый endpoint: ожидается JSON вида
 * { results: [{ title, url, snippet }] } или массив вложенных полей
 * (data.results, items). Позволяет подключить собственный шлюз.
 */
export const customSearchAdapter: SearchAdapter = {
  type: 'custom',
  label: 'Custom JSON Search',
  requiresKey: false,
  defaultBaseUrl: '',
  async search(connection, query, signal) {
    if (!connection.baseUrl) {
      throw new AppError('SEARCH_NOT_CONFIGURED', 'Для custom-поиска укажите Base URL');
    }
    const headers: Record<string, string> = {};
    if (connection.apiKey) headers.authorization = `Bearer ${connection.apiKey}`;

    const { data } = await httpJson<CustomResponse | unknown[]>(connection.baseUrl, {
      method: 'POST',
      headers,
      body: {
        query: query.query,
        limit: query.limit ?? 5,
        language: query.language,
        ...(typeof connection.options.extraBody === 'object' && connection.options.extraBody
          ? (connection.options.extraBody as Record<string, unknown>)
          : {}),
      },
      timeoutMs: 30_000,
      signal,
      label: 'Custom search',
    });

    const items = Array.isArray(data) ? data : (data.results ?? []);
    return items
      .map((raw): SearchHit | null => {
        if (!raw || typeof raw !== 'object') return null;
        const item = raw as Record<string, unknown>;
        const url = typeof item.url === 'string' ? item.url : typeof item.link === 'string' ? item.link : '';
        if (!url) return null;
        const title = typeof item.title === 'string' ? item.title : url;
        const snippet =
          typeof item.snippet === 'string' ? item.snippet : typeof item.description === 'string' ? item.description : '';
        return {
          title: title.trim(),
          url: normalizeUrl(url),
          snippet: snippet.slice(0, 1200),
          publisher: publisherFromUrl(url),
          publishedAt: typeof item.publishedAt === 'string' ? item.publishedAt : '',
          score: typeof item.score === 'number' ? item.score : null,
        };
      })
      .filter((hit): hit is SearchHit => hit !== null)
      .slice(0, query.limit ?? 5);
  },
};
