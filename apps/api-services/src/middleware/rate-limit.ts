// ============================================================
// Rate Limiting Middleware — token bucket algorithm
// Dual strategy:
//   1. IP-based: X-Forwarded-For trusted proxy chain only
//   2. API-Key-based: for authenticated requests (cannot be spoofed)
// ============================================================

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

/**
 * Trusted reverse proxy CIDRs.
 * In production, only Caddy/Nginx should set X-Forwarded-For.
 * Add your proxy IPs here to prevent spoofing.
 */
const TRUSTED_PROXY_CIDRS = (process.env.TRUSTED_PROXY_CIDRS || "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function ipMatchesCIDR(ip: string, cidr: string): boolean {
  // Simple prefix-match for /8, /12, /16, /24
  const [range, bits] = cidr.split("/");
  if (!bits) return ip === range;

  const maskBits = parseInt(bits, 10);
  const ipParts = ip.split(".").map(Number);
  const rangeParts = range.split(".").map(Number);

  if (ipParts.length !== 4 || rangeParts.length !== 4) return false;

  const ipInt = (ipParts[0]! << 24) | (ipParts[1]! << 16) | (ipParts[2]! << 8) | ipParts[3]!;
  const rangeInt = (rangeParts[0]! << 24) | (rangeParts[1]! << 16) | (rangeParts[2]! << 8) | rangeParts[3]!;
  const mask = ~((1 << (32 - maskBits)) - 1);

  return (ipInt & mask) === (rangeInt & mask);
}

function getClientIp(req: Request): string {
  const remoteAddr = req.socket.remoteAddress || "unknown";

  // If no X-Forwarded-For, use direct remote address
  const forwarded = req.headers["x-forwarded-for"] as string | undefined;
  if (!forwarded) return remoteAddr;

  // Parse the X-Forwarded-For chain: client, proxy1, proxy2, ...
  const hops = forwarded.split(",").map((s) => s.trim()).filter(Boolean);

  // Walk from rightmost (closest to our server) to leftmost (original client).
  // If all rightmost hops are trusted proxies, the leftmost untrusted hop is the real client IP.
  // Otherwise, fall back to remoteAddress.
  let trustedCount = 0;
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i]!;
    if (TRUSTED_PROXY_CIDRS.some((cidr) => ipMatchesCIDR(hop, cidr))) {
      trustedCount++;
    } else {
      break;
    }
  }

  // All hops are trusted → leftmost is the real client IP
  if (trustedCount === hops.length) {
    return hops[0]!;
  }

  // Partial trust chain — rightmost trusted, leftmost untrusted is real client
  if (trustedCount > 0) {
    return hops[hops.length - trustedCount - 1]!;
  }

  // No trusted hops → X-Forwarded-For is likely spoofed, use remoteAddress
  return remoteAddr;
}

function getAuthKey(req: Request): string {
  const authHeader = req.headers.authorization || "";
  // Per RFC 7235 §2.1, auth-scheme is case-insensitive
  const isBearer = authHeader.length >= 7 && authHeader.slice(0, 7).toLowerCase() === "bearer ";
  const token = isBearer
    ? authHeader.slice(7)
    : (req.headers["x-api-key"] as string) || "";

  // Hash to avoid storing raw keys in memory
  if (!token) return "";
  // Simple hash — sufficient for rate-limit key dedup, not security
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    const ch = token.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return "ak:" + hash.toString(36);
}

export async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.path === "/health" || req.path === "/ready" || req.path.startsWith("/api/webhook/") || req.path.startsWith("/api/v1/webhook/")) {
    next();
    return;
  }

  const ip = getClientIp(req);
  const authKey = getAuthKey(req);
  const now = Date.now();

  // Prefer API-key-based key for authenticated requests (not spoofable)
  const rateLimitKey = authKey || `ip:${ip}`;

  let bucket: Bucket | null = null;
  const redisBucket = await getRateLimitBucket(rateLimitKey);

  if (redisBucket) {
    bucket = redisBucket;
  } else {
    bucket = buckets.get(rateLimitKey) || null;
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
      await setRateLimitBucket(rateLimitKey, bucket.tokens, bucket.lastRefill);
    } else {
      buckets.set(rateLimitKey, bucket);
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
