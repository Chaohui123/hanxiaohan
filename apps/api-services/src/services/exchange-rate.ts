// ============================================================
// Exchange Rate Service — CNY→RUB real-time rate with cache
// Replaces hardcoded 11.5 in pipeline pricing
// ============================================================

interface RateCache {
  rate: number;
  timestamp: number;
}

let cache: RateCache | null = null;
const CACHE_TTL_MS = 3600_000; // 1 hour
const FALLBACK_RATE = 11.5;

/**
 * Fetch current CNY→RUB exchange rate.
 * Uses exchangerate-api.com free tier, cached for 1 hour.
 * Falls back to 11.5 if API is unreachable.
 */
export async function getExchangeRate(): Promise<{ rate: number; cached: boolean }> {
  if (cache && Date.now() - cache.timestamp < CACHE_TTL_MS) {
    return { rate: cache.rate, cached: true };
  }

  try {
    // Free tier exchangerate API: USD-based, need CNY→USD→RUB
    const [cnyRes, rubRes] = await Promise.all([
      fetch("https://open.er-api.com/v6/latest/CNY", { signal: AbortSignal.timeout(10_000) }),
      fetch("https://open.er-api.com/v6/latest/RUB", { signal: AbortSignal.timeout(10_000) }),
    ]);

    if (cnyRes.ok && rubRes.ok) {
      const cnyData = await cnyRes.json() as { rates: Record<string, number> };
      const rubData = await rubRes.json() as { rates: Record<string, number> };

      // CNY→USD and RUB→USD, so CNY→RUB = (1/USD_per_CNY) * USD_per_RUB
      const cnyToUsd = cnyData.rates["USD"] ?? 0.14;
      const rubToUsd = rubData.rates["USD"] ?? 0.011;
      const rate = rubToUsd > 0 ? cnyToUsd / rubToUsd : FALLBACK_RATE;

      cache = { rate: Math.round(rate * 100) / 100, timestamp: Date.now() };
      return { rate: cache.rate, cached: false };
    }
  } catch {
    // Network error — use fallback
  }

  return { rate: cache?.rate ?? FALLBACK_RATE, cached: true };
}

/**
 * Force refresh the cached rate (admin use).
 */
export function clearRateCache(): void {
  cache = null;
}
