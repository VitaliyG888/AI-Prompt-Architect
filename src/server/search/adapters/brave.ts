/** Адаптер Brave Search API. */
import { httpJson } from '../../core/http.ts';
import { AppError } from '../../core/errors.ts';
import { publisherFromUrl, normalizeUrl, type SearchAdapter, type SearchHit } from '../types.ts';

interface BraveResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      age?: string;
      page_age?: string;
    }>;
  };
}

export const braveAdapter: SearchAdapter = {
  type: 'brave',
  label: 'Brave Search',
  requiresKey: true,
  defaultBaseUrl: 'https://api.search.brave.com/res/v1',
  async search(connection, query, signal) {
    if (!connection.apiKey) throw new AppError('SEARCH_NOT_CONFIGURED', 'Brave Search требует API-ключ');
    const base = connection.baseUrl || 'https://api.search.brave.com/res/v1';
    const params = new URLSearchParams({
      q: query.query,
      count: String(Math.min(query.limit ?? 5, 20)),
    });
    if (query.language) params.set('search_lang', query.language);
    if (query.region) params.set('country', query.region.toUpperCase());
    if (query.freshnessDays) params.set('freshness', `pd${query.freshnessDays}`);

    const { data } = await httpJson<BraveResponse>(`${base}/web/search?${params.toString()}`, {
      method: 'GET',
      headers: {
        'x-subscription-token': connection.apiKey,
        accept: 'application/json',
      },
      timeoutMs: 30_000,
      signal,
      label: 'Brave Search',
    });

    return (data.web?.results ?? [])
      .filter((item): item is { url: string; title?: string; description?: string } => typeof item.url === 'string')
      .map<SearchHit>((item) => ({
        title: item.title?.trim() || item.url,
        url: normalizeUrl(item.url),
        snippet: (item.description ?? '').slice(0, 1200),
        publisher: publisherFromUrl(item.url),
        publishedAt: (item as { page_age?: string }).page_age ?? (item as { age?: string }).age ?? '',
        score: null,
      }));
  },
};
