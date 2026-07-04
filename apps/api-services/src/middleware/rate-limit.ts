// ============================================================
// API-level rate limiter — token bucket per IP
// Prevents abuse of the Express API endpoints
// ============================================================

import type { Request, Response, NextFunction } from "express";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

// Config: max 60 requests per minute per IP
const MAX_TOKENS = parseInt(process.env.RATE_LIMIT_MAX || "60", 10);
const REFILL_RATE = MAX_TOKENS / 60_000; // tokens per ms (1 min window)
const REFILL_INTERVAL_MS = 10_000; // clean stale entries every 10s

// Periodic cleanup of stale buckets
let lastCleanup = Date.now();
function cleanupStale(): void {
  const now = Date.now();
  if (now - lastCleanup < REFILL_INTERVAL_MS) return;
  lastCleanup = now;

  // Remove buckets not used in the last 5 minutes
  const stale = now - 5 * 60 * 1000;
  for (const [key, bucket] of buckets) {
    if (bucket.lastRefill < stale) {
      buckets.delete(key);
    }
  }
}

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"] as string | undefined;
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip rate limiting for health endpoints
  if (req.path === "/health" || req.path === "/ready") {
    next();
    return;
  }

  const ip = getClientIp(req);
  const now = Date.now();

  let bucket = buckets.get(ip);
  if (!bucket) {
    bucket = { tokens: MAX_TOKENS, lastRefill: now };
    buckets.set(ip, bucket);
  }

  // Refill tokens based on elapsed time
  const elapsed = now - bucket.lastRefill;
  if (elapsed > 0) {
    bucket.tokens = Math.min(MAX_TOKENS, bucket.tokens + elapsed * REFILL_RATE);
    bucket.lastRefill = now;
  }

  // Consume 1 token
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    cleanupStale();
    next();
  } else {
    const retryAfter = Math.ceil((1 - bucket.tokens) / REFILL_RATE / 1000);
    res.set("Retry-After", String(Math.max(1, retryAfter)));
    res.set("X-RateLimit-Limit", String(MAX_TOKENS));
    res.set("X-RateLimit-Remaining", "0");
    res.status(429).json({
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: `Too many requests. Retry after ${Math.max(1, retryAfter)} seconds.`,
        retryable: true,
      },
      correlationId: (req as Request & { correlationId?: string }).correlationId ?? "unknown",
    });
  }
}
