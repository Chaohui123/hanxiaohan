// ============================================================
// Exchange Rate Service — CNY→RUB with dual-source + deadlock
// Primary: open.er-api.com (free)
// Secondary: frankfurter.app (free, no key needed)
// Safety: blocks listing when rate is unreliable (>5% deviation
//   between sources, or >48h stale cache)
// ============================================================

import { emitEvent, EVENT_KEYS } from "./notification-events.js";
import { cache } from "@onzo/cache";

// Redis cache key — stores JSON: { rate, timestamp, source } with 1h TTL
const CACHE_KEY = "onzo:exchange-rate:latest";

interface RateCache {
  rate: number;
  timestamp: number;
  source: string;
}

let localCache: RateCache | null = null;
const CACHE_TTL_MS = 3600_000; // 1 hour
const STALE_WARN_MS = 24 * 3600_000; // 24 hours
const STALE_BLOCK_MS = 48 * 3600_000; // 48 hours — refuse to use
const MAX_DEVIATION_PCT = 5; // max % difference between sources before flagging
const FALLBACK_RATE = 11.5;

export interface RateResult {
  rate: number;
  cached: boolean;
  stale: boolean;
  /** false = using hardcoded fallback — pricing will be wrong */
  reliable: boolean;
  source: string;
}

/**
 * Fetch USD-based rates from open.er-api.com.
 * Returns CNY→USD and RUB→USD to compute CNY→RUB cross rate.
 */
async function fetchPrimary(): Promise<number | null> {
  try {
    const [cnyRes, rubRes] = await Promise.all([
      fetch("https://open.er-api.com/v6/latest/CNY", { signal: AbortSignal.timeout(10_000) }),
      fetch("https://open.er-api.com/v6/latest/RUB", { signal: AbortSignal.timeout(10_000) }),
    ]);

    if (!cnyRes.ok || !rubRes.ok) return null;

    const cnyData = await cnyRes.json() as { rates: Record<string, number> };
    const rubData = await rubRes.json() as { rates: Record<string, number> };

    const cnyToUsd = cnyData.rates["USD"] ?? 0.14;
    const rubToUsd = rubData.rates["USD"] ?? 0.011;
    return rubToUsd > 0 ? cnyToUsd / rubToUsd : null;
  } catch {
    return null;
  }
}

/**
 * Fetch from frankfurter.app (secondary source).
 * Returns CNY→RUB directly.
 */
async function fetchSecondary(): Promise<number | null> {
  try {
    const res = await fetch(
      "https://api.frankfurter.app/latest?from=CNY&to=RUB",
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return null;
    const data = await res.json() as { rates: { RUB: number } };
    return data.rates?.RUB ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch current CNY→RUB exchange rate with dual-source validation.
 *
 * Behavior:
 * - Fresh from API (both sources agree within 5%) → reliable=true
 * - Fresh from API but sources disagree >5% → reliable=false, warn
 * - Cached <24h → reliable=true
 * - Cached 24-48h → reliable=true but stale warn
 * - Cached >48h → reliable=false, BLOCK listing
 * - Hardcoded fallback 11.5 → reliable=false, BLOCK listing
 */
export async function getExchangeRate(): Promise<RateResult> {
  // 1. Redis cache (primary — shared across processes)
  const redisCached = await cache.get(CACHE_KEY).catch(() => null);
  if (redisCached) {
    try {
      const parsed = JSON.parse(redisCached) as RateCache;
      if (Date.now() - parsed.timestamp < CACHE_TTL_MS) {
        localCache = parsed;
        const hoursStale = (Date.now() - parsed.timestamp) / 3600_000;
        return { rate: parsed.rate, cached: true, stale: hoursStale > 24, reliable: hoursStale < 48, source: parsed.source };
      }
    } catch { /* corrupted */ }
  }

  // 2. Memory fallback (survives Redis restart)
  if (localCache && Date.now() - localCache.timestamp < CACHE_TTL_MS) {
    const hoursStale = (Date.now() - localCache.timestamp) / 3600_000;
    return {
      rate: localCache.rate,
      cached: true,
      stale: hoursStale > 24,
      reliable: hoursStale < 48,
      source: localCache.source,
    };
  }

  // Try primary + secondary in parallel
  const [primaryRate, secondaryRate] = await Promise.all([
    fetchPrimary(),
    fetchSecondary(),
  ]);

  // Both succeeded — validate consistency
  if (primaryRate !== null && secondaryRate !== null) {
    const deviation = Math.abs(primaryRate - secondaryRate) / primaryRate * 100;
    const avgRate = Math.round((primaryRate + secondaryRate) / 2 * 100) / 100;

    if (deviation > MAX_DEVIATION_PCT) {
      console.warn(
        `[ExchangeRate] Dual-source deviation ${deviation.toFixed(1)}% exceeds ${MAX_DEVIATION_PCT}% threshold. ` +
        `Primary=${primaryRate.toFixed(2)}, Secondary=${secondaryRate.toFixed(2)}. Using average=${avgRate.toFixed(2)}`
      );
    }

    localCache = { rate: avgRate, timestamp: Date.now(), source: `dual:${avgRate}` };
    cache.set(CACHE_KEY, JSON.stringify(localCache), 3600).catch(() => {});
    return { rate: avgRate, cached: false, stale: false, reliable: deviation <= MAX_DEVIATION_PCT, source: "dual" };
  }

  // One source succeeded
  if (primaryRate !== null || secondaryRate !== null) {
    const rate = Math.round((primaryRate ?? secondaryRate!) * 100) / 100;
    const source = primaryRate ? "primary" : "secondary";

    console.warn(`[ExchangeRate] Only ${source} source available. Using rate=${rate}.`);
    localCache = { rate, timestamp: Date.now(), source };
    cache.set(CACHE_KEY, JSON.stringify(localCache), 3600).catch(() => {});
    return { rate, cached: false, stale: false, reliable: primaryRate !== null, source };
  }

  // Both sources failed — evaluate cache freshness
  if (localCache) {
    const hoursStale = (Date.now() - localCache.timestamp) / 3600_000;

    if (hoursStale > STALE_BLOCK_MS) {
      console.error(
        `[ExchangeRate] BLOCKING: Cache is ${hoursStale.toFixed(0)}h old (>${STALE_BLOCK_MS / 3600_000}h).`
      );
      emitEvent(EVENT_KEYS.EXCHANGE_RATE_STALE, {
        hoursStale: hoursStale.toFixed(0),
        rate: String(localCache.rate),
        source: localCache.source,
      }).catch(() => {});
      return {
        rate: localCache.rate,
        cached: true,
        stale: true,
        reliable: false,
        source: `stale-cache:${localCache.rate}`,
      };
    }

    console.warn(`[ExchangeRate] Using cached rate ${localCache.rate} (${hoursStale.toFixed(0)}h old).`);
    return {
      rate: localCache.rate,
      cached: true,
      stale: hoursStale > 24,
      reliable: hoursStale < 48,
      source: `cached:${localCache.rate}`,
    };
  }

  // No cache, no API — hardcoded fallback
  console.error(`[ExchangeRate] BLOCKING: No cache and both APIs failed. Using hardcoded ${FALLBACK_RATE}.`);
  return {
    rate: FALLBACK_RATE,
    cached: true,
    stale: true,
    reliable: false,
    source: "hardcoded-fallback",
  };
}

/**
 * Force refresh — clears both Redis and memory cache.
 * Next getExchangeRate() call will re-fetch from API.
 */
export function forceRefreshRate(): void {
  localCache = null;
  cache.del(CACHE_KEY).catch(() => {});
}
