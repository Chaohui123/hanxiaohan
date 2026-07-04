// ============================================================
// URL-based idempotency — prevents duplicate 1688 submissions
// ============================================================

import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { cache } from "@onzo/cache";

const recentHashes = new Map<string, number>(); // hash → expiry timestamp
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/** Clean expired entries periodically */
setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of recentHashes) {
    if (expiry <= now) recentHashes.delete(key);
  }
}, 60_000);

export async function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Only check POST /api/process/*
  if (!req.path.startsWith("/api/process")) {
    next();
    return;
  }

  const url = (req.body as Record<string, unknown>)?.url as string | undefined;
  if (!url) {
    next();
    return;
  }

  const hash = crypto.createHash("sha256").update(url.trim()).digest("hex").substring(0, 16);

  // Check Redis first (shared across processes), fall back to memory
  const redisCheck = await cache.get(`idem:${hash}`).catch(() => null);
  const existing = redisCheck ? parseInt(redisCheck) : recentHashes.get(hash);

  if (existing && existing > Date.now()) {
    res.status(409).json({
      success: false,
      error: {
        code: "DUPLICATE",
        message: `This 1688 URL was submitted within the last ${DEDUP_WINDOW_MS / 60000} minutes. Skipping duplicate.`,
        retryable: false,
      },
      correlationId: req.correlationId,
    });
    return;
  }

  recentHashes.set(hash, Date.now() + DEDUP_WINDOW_MS);
  cache.set(`idem:${hash}`, String(Date.now() + DEDUP_WINDOW_MS), 300).catch(() => {});
  next();
}
