// ============================================================
// Ozon API Rate Limiter — Redis counter-based, per-store
// Prevents 429 errors from Ozon Seller API
// Uses sliding window with configurable RPM (requests per minute)
// ============================================================

import type { Request, Response, NextFunction } from "express";
import { cache } from "@onzo/cache";
import { logger } from "@onzo/logger";

const OZON_RPM = parseInt(process.env.OZON_RATE_LIMIT_RPM || "180", 10); // Ozon default: 180 req/min
const WINDOW_SEC = 60;
const COUNTER_PREFIX = "onzo:ratelimit:ozon:";

/** Apply Ozon API rate limiting. Call before any Ozon API request. */
export async function ozonRateLimiter(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Only rate-limit Ozon API calls (paths that hit Ozon)
  const path = req.path;
  const isOzonPath = path.startsWith("/api/ozon") || path.startsWith("/api/orders") || path.startsWith("/api/process") || path.startsWith("/api/price") || path.startsWith("/api/inventory")
    || path.startsWith("/api/v1/ozon") || path.startsWith("/api/v1/orders") || path.startsWith("/api/v1/process") || path.startsWith("/api/v1/price") || path.startsWith("/api/v1/inventory");
  if (!isOzonPath) {
    next();
    return;
  }

  const storeId = (req.query?.storeId as string) || (req.body as Record<string, unknown>)?.storeId as string || "store_1";
  const key = `${COUNTER_PREFIX}${storeId}`;

  try {
    const count = await cache.counterIncr("ratelimit:ozon", storeId, WINDOW_SEC);

    res.set("X-Ozon-RateLimit-Limit", String(OZON_RPM));
    res.set("X-Ozon-RateLimit-Remaining", String(Math.max(0, OZON_RPM - count)));

    if (count > OZON_RPM) {
      logger.warn({ storeId, count, limit: OZON_RPM }, "OzonRateLimiter: rate limit exceeded");
      res.status(429).json({
        success: false,
        error: {
          code: "OZON_RATE_LIMITED",
          message: `Ozon API rate limit exceeded (${OZON_RPM}/min). Retry after ${WINDOW_SEC}s.`,
          retryable: true,
        },
        correlationId: (req as Request & { correlationId?: string }).correlationId ?? "unknown",
      });
      return;
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "OzonRateLimiter: Redis unavailable, allowing request");
  }

  next();
}