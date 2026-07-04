import type { Request, Response, NextFunction } from "express";
import { getRateLimitBucket, setRateLimitBucket } from "../cache/redis.js";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

const MAX_TOKENS = parseInt(process.env.RATE_LIMIT_MAX || "60", 10);
const REFILL_RATE = MAX_TOKENS / 60_000;
const REFILL_INTERVAL_MS = 10_000;

let lastCleanup = Date.now();
function cleanupStale(): void {
  const now = Date.now();
  if (now - lastCleanup < REFILL_INTERVAL_MS) return;
  lastCleanup = now;

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

export async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.path === "/health" || req.path === "/ready") {
    next();
    return;
  }

  const ip = getClientIp(req);
  const now = Date.now();

  let bucket: Bucket | null = null;
  const redisBucket = await getRateLimitBucket(ip);

  if (redisBucket) {
    bucket = redisBucket;
  } else {
    bucket = buckets.get(ip) || null;
    if (!bucket) {
      bucket = { tokens: MAX_TOKENS, lastRefill: now };
    }
  }

  const elapsed = now - bucket.lastRefill;
  if (elapsed > 0) {
    bucket.tokens = Math.min(MAX_TOKENS, bucket.tokens + elapsed * REFILL_RATE);
    bucket.lastRefill = now;
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    
    if (redisBucket !== null) {
      await setRateLimitBucket(ip, bucket.tokens, bucket.lastRefill);
    } else {
      buckets.set(ip, bucket);
      cleanupStale();
    }
    
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