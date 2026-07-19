// ============================================================
// Circuit Breakers — Centralized opossum-based fault tolerance
// Replaces custom CircuitBreaker implementations with opossum.
// Configures breakers for all external services.
// ============================================================

import { logger } from "@onzo/logger";

let opossumMod: typeof import("opossum") | null = null;
async function getOpossum() {
  if (!opossumMod) {
    try { opossumMod = await import("opossum"); }
    catch { logger.warn("opossum not installed — circuit breakers disabled"); }
  }
  return opossumMod;
}

export type BreakerName = "deepseek" | "kimiVision" | "socketIo" | "ozonApi" | "scraper1688";

export interface BreakerConfig {
  name: BreakerName;
  failureThreshold: number;
  resetTimeout: number;
  timeout: number;
  enabled: boolean;
}

export interface BreakerMetrics {
  name: BreakerName;
  state: string;
  failures: number;
  successes: number;
  fallbacks: number;
  lastFailure?: string;
}

const DEFAULT_CONFIGS: Record<BreakerName, Omit<BreakerConfig, "name">> = {
  deepseek: {
    failureThreshold: parseInt(process.env.CB_DEEPSEEK_THRESHOLD || "5", 10),
    resetTimeout: parseInt(process.env.CB_DEEPSEEK_TIMEOUT || "60000", 10),
    timeout: 30_000,
    enabled: true,
  },
  kimiVision: {
    failureThreshold: parseInt(process.env.CB_KIMI_THRESHOLD || "3", 10),
    resetTimeout: parseInt(process.env.CB_KIMI_TIMEOUT || "60000", 10),
    timeout: 30_000,
    enabled: true,
  },
  socketIo: {
    failureThreshold: parseInt(process.env.CB_SOCKETIO_THRESHOLD || "5", 10),
    resetTimeout: 30_000,
    timeout: 10_000,
    enabled: true,
  },
  ozonApi: {
    failureThreshold: parseInt(process.env.CB_OZON_THRESHOLD || "10", 10),
    resetTimeout: 30_000,
    timeout: 30_000,
    enabled: true,
  },
  scraper1688: {
    failureThreshold: parseInt(process.env.CB_1688_THRESHOLD || "5", 10),
    resetTimeout: 120_000,
    timeout: 60_000,
    enabled: true,
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const breakers = new Map<BreakerName, any>();

/**
 * Get or create an opossum circuit breaker for a named service.
 * Falls back to a no-op pass-through if opossum is unavailable.
 */
export async function getBreaker(name: BreakerName): Promise<{
  fire: <T>(fn: () => Promise<T>, fallback?: () => Promise<T>) => Promise<T>;
  readonly stats: { failures: number; successes: number; fallbacks: number };
  readonly opened: boolean;
}> {
  if (breakers.has(name)) return breakers.get(name);

  const opossum = await getOpossum();
  const cfg = DEFAULT_CONFIGS[name];

  if (!opossum || !cfg.enabled) {
    // No-op pass-through
    const passthrough = {
      fire: async <T>(fn: () => Promise<T>) => fn(),
      stats: { failures: 0, successes: 0, fallbacks: 0 },
      opened: false,
    };
    breakers.set(name, passthrough);
    return passthrough;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const breaker = new (opossum as any).CircuitBreaker(
    async (...args: unknown[]) => {
      const fn = args[0] as () => Promise<unknown>;
      return fn();
    },
    {
      timeout: cfg.timeout,
      errorThresholdPercentage: Math.floor((cfg.failureThreshold / 10) * 100),
      resetTimeout: cfg.resetTimeout,
      name,
    },
  );

  breaker.on("open", () => {
    logger.error({ breaker: name }, "CIRCUIT_BREAKER_OPEN");
    emitBreakerAlert(name, "open").catch(() => {});
  });
  breaker.on("halfOpen", () => {
    logger.warn({ breaker: name }, "CIRCUIT_BREAKER_HALF_OPEN");
  });
  breaker.on("close", () => {
    logger.info({ breaker: name }, "CIRCUIT_BREAKER_CLOSED");
  });

  breakers.set(name, breaker);
  return breaker;
}

/**
 * Wrap a function with a named circuit breaker and optional fallback.
 * Usage: breakerFire("deepseek", () => deepseekClient.chatCompletion(...), () => cachedResult)
 */
export async function breakerFire<T>(
  name: BreakerName,
  fn: () => Promise<T>,
  fallback?: () => Promise<T>,
): Promise<T> {
  const breaker = await getBreaker(name);
  if (fallback) {
    return breaker.fire(fn, fallback);
  }
  return breaker.fire(fn);
}

/** Get metrics for all registered breakers */
export async function getBreakerMetrics(): Promise<BreakerMetrics[]> {
  const metrics: BreakerMetrics[] = [];
  for (const [name, breaker] of breakers) {
    metrics.push({
      name,
      state: breaker.opened ? "open" : "closed",
      failures: breaker.stats.failures,
      successes: breaker.stats.successes,
      fallbacks: breaker.stats.fallbacks,
    });
  }
  return metrics;
}

/** Reset a specific breaker */
export async function resetBreaker(name: BreakerName): Promise<void> {
  breakers.delete(name);
  logger.info({ breaker: name }, "Circuit breaker reset");
}

// ---- Internal ----

async function emitBreakerAlert(name: string, state: string): Promise<void> {
  try {
    const { emitEvent } = await import("../services/notification-events.js");
    await emitEvent("CIRCUIT_BREAKER_OPEN", {
      service: name,
      state,
      failures: String(breakers.get(name as BreakerName)?.stats?.failures || 0),
    });
  } catch { /* notification unavailable */ }
}
