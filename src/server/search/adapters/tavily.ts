/** Адаптер Tavily Search API. */
import { httpJson } from '../../core/http.ts';
import { AppError } from '../../core/errors.ts';
import { publisherFromUrl, normalizeUrl, type SearchAdapter, type SearchHit } from '../types.ts';

interface TavilyResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    published_date?: string;
    score?: number;
  }>;
}

export const tavilyAdapter: SearchAdapter = {
  type: 'tavily',
  label: 'Tavily',
  requiresKey: true,
  defaultBaseUrl: 'https://api.tavily.com',
  async search(connection, query, signal) {
    if (!connection.apiKey) {
      throw new AppError('SEARCH_NOT_CONFIGURED', 'Tavily требует API-ключ');
    }
    const { data } = await httpJson<TavilyResponse>(`${connection.baseUrl || 'https://api.tavily.com'}/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${connection.apiKey}` },
      body: {
        query: query.query,
        max_results: Math.min(query.limit ?? 5, 20),
        search_depth: connection.options.searchDepth === 'advanced' ? 'advanced' : 'basic',
        include_answer: false,
        include_raw_content: false,
        ...(query.freshnessDays ? { days: query.freshnessDays } : {}),
      },
      timeoutMs: 30_000,
      signal,
      label: 'Tavily',
    });

    return (data.results ?? [])
      .filter(
        (item): item is { title?: string; url: string; content?: string; published_date?: string; score?: number } =>
          typeof item.url === 'string',
      )
      .map<SearchHit>((item) => ({
        title: item.title?.trim() || item.url,
        url: normalizeUrl(item.url),
        snippet: (item.content ?? '').slice(0, 1200),
        publisher: publisherFromUrl(item.url),
        publishedAt: item.published_date ?? '',
        score: typeof item.score === 'number' ? item.score : null,
      }));
  },
};
