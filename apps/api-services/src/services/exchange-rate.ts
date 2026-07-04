// ============================================================
// Exchange Rate Service — CNY→RUB with dual-source + deadlock
// Primary: open.er-api.com (free)
// Secondary: frankfurter.app (free, no key needed)
// Safety: blocks listing when rate is unreliable (>5% deviation
//   between sources, or >48h stale cache)
// ============================================================

import { emitEvent, EVENT_KEYS } from "./notification-events.js";

interface RateCache {
  rate: number;
  timestamp: number;
  source: string;
}

let cache: RateCache | null = null;
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
  // Fast path: fresh cache
  if (cache && Date.now() - cache.timestamp < CACHE_TTL_MS) {
    const hoursStale = (Date.now() - cache.timestamp) / 3600_000;
    return {
      rate: cache.rate,
      cached: true,
      stale: hoursStale > 24,
      reliable: hoursStale < 48,
      source: cache.source,
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
        `Primary=${primaryRate.toFixed(2)}, Secondary=${secondaryRate.toFixed(2)}. Using average=${avgRate.toFixed(2)} — listing NOT blocked but rate may be inaccurate.`
      );
    }

    cache = { rate: avgRate, timestamp: Date.now(), source: `dual:${avgRate}` };
    return { rate: avgRate, cached: false, stale: false, reliable: deviation <= MAX_DEVIATION_PCT, source: "dual" };
  }

  // One source succeeded
  if (primaryRate !== null || secondaryRate !== null) {
    const rate = Math.round((primaryRate ?? secondaryRate!) * 100) / 100;
    const source = primaryRate ? "primary" : "secondary";

    console.warn(`[ExchangeRate] Only ${source} source available. Using rate=${rate}.`);
    cache = { rate, timestamp: Date.now(), source };
    // Single source is reliable enough if it's the primary
    return { rate, cached: false, stale: false, reliable: primaryRate !== null, source };
  }

  // Both sources failed — evaluate cache freshness
  if (cache) {
    const hoursStale = (Date.now() - cache.timestamp) / 3600_000;

    if (hoursStale > STALE_BLOCK_MS) {
      console.error(
        `[ExchangeRate] BLOCKING: Cache is ${hoursStale.toFixed(0)}h old (>${STALE_BLOCK_MS / 3600_000}h). ` +
        `Both rate APIs are down. Refusing to list with unreliable rate.`
      );
      emitEvent(EVENT_KEYS.EXCHANGE_RATE_STALE, {
        hoursStale: hoursStale.toFixed(0),
        rate: String(cache.rate),
        source: cache.source,
      }).catch(() => {});
      return {
        rate: cache.rate,
        cached: true,
        stale: true,
        reliable: false,
        source: `stale-cache:${cache.rate}`,
      };
    }

    console.warn(
      `[ExchangeRate] Using cached rate ${cache.rate} (${hoursStale.toFixed(0)}h old). ` +
      `Both rate APIs are unreachable.`
    );
    return {
      rate: cache.rate,
      cached: true,
      stale: hoursStale > 24,
      reliable: hoursStale < 48,
      source: `cached:${cache.rate}`,
    };
  }

  // No cache, no API — hardcoded fallback
  console.error(
    `[ExchangeRate] BLOCKING: No cached rate and both APIs failed. ` +
    `Using hardcoded ${FALLBACK_RATE} — CNY→RUB pricing WILL be wrong.`
  );
  return {
    rate: FALLBACK_RATE,
    cached: true,
    stale: true,
    reliable: false,
    source: "hardcoded-fallback",
  };
}

/**
 * Force refresh the cached rate (admin use).
 */
export function clearRateCache(): void {
  cache = null;
}
