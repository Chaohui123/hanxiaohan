// ============================================================
// Promo Cache — Redis-backed with in-memory fallback
// ============================================================

import { cache } from "@onzo/cache";
import { logger } from "@onzo/logger";

const DEFAULT_TTL = 300; // 5 minutes

function cacheKey(key: string): string {
  return `promo:${key}`;
}

/**
 * Cache-aside: fetch from cache, or compute + store.
 */
export async function getCached<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttl = DEFAULT_TTL,
): Promise<T> {
  const fullKey = cacheKey(key);
  try {
    const cached = await cache.get(fullKey);
    if (cached) return JSON.parse(cached) as T;
  } catch { /* cache miss */ }

  const data = await fetcher();

  try {
    await cache.set(fullKey, JSON.stringify(data), ttl);
  } catch { /* cache write fail */ }

  return data;
}

/**
 * Cache-aside with stale fallback: on DB error, serve expired cache.
 */
export async function getCachedOrStale<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttl = DEFAULT_TTL,
): Promise<T> {
  try {
    return await getCached(key, fetcher, ttl);
  } catch (err) {
    logger.warn({ err, key }, "Fetcher failed, trying stale cache");
    const fullKey = cacheKey(key);
    const stale = await cache.get(fullKey).catch(() => null);
    if (stale) {
      logger.warn({ key }, "Serving stale cache");
      return JSON.parse(stale) as T;
    }
    throw err;
  }
}

/**
 * Invalidate cache entries matching a key prefix.
 */
export async function invalidateCache(key: string): Promise<void> {
  const fullKey = cacheKey(key);
  try {
    await cache.del(fullKey);
  } catch { /* ignore */ }
}
