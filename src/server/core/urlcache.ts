/** Кэш проверок SSRF: DNS-резолвинг не должен выполняться на каждый запрос. */
import { assertSafeUrl, type UrlCheckResult } from './ssrf.ts';

interface CacheEntry {
  result: UrlCheckResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 5 * 60 * 1000;

export function clearUrlCache(): void {
  cache.clear();
}

/** Проверка URL с кэшированием результата на 5 минут. */
export async function assertSafeUrlCached(
  rawUrl: string,
  allowPrivate: boolean,
): Promise<UrlCheckResult> {
  const key = `${allowPrivate ? 'p' : 's'}:${rawUrl}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const result = await assertSafeUrl(rawUrl, allowPrivate);
  cache.set(key, { result, expiresAt: Date.now() + TTL_MS });
  if (cache.size > 500) {
    // Простая эвикция: удаляем самые старые записи.
    const entries = [...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [oldKey] of entries.slice(0, 100)) cache.delete(oldKey);
  }
  return result;
}
