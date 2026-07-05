// ============================================================
// Simple in-memory rate limiter for promo/rag routes
// ============================================================

import type { Request, Response, NextFunction } from "express";

const windowMs = 60_000; // 1 minute
const maxRequests = 60; // max 60 requests per minute per IP

const buckets = new Map<string, { count: number; resetAt: number }>();

export function ragRateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const bucket = buckets.get(ip);

  if (!bucket || now > bucket.resetAt) {
    buckets.set(ip, { count: 1, resetAt: now + windowMs });
    next();
    return;
  }

  bucket.count++;
  if (bucket.count > maxRequests) {
    res.status(429).json({ error: "Too many requests, slow down" });
    return;
  }

  next();
}

// Cleanup stale buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of buckets) {
    if (now > bucket.resetAt) buckets.delete(ip);
  }
}, 300_000);
