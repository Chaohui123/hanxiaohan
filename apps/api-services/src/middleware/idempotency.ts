// ============================================================
// URL-based idempotency — prevents duplicate 1688 submissions
// ============================================================

import type { Request, Response, NextFunction } from "express";
import { TTL } from "@onzo/cache";
import { lockDedupListing } from "../services/redis-lock.js";

export async function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Only check POST /api/process/* and /api/v1/process/*
  if (!req.path.startsWith("/api/process") && !req.path.startsWith("/api/v1/process")) {
    next();
    return;
  }

  const url = (req.body as Record<string, unknown>)?.url as string | undefined;
  if (!url) {
    next();
    return;
  }

  // Use Redis distributed lock for dedup (cross-process safe)
  const token = await lockDedupListing(url);
  if (!token) {
    res.status(409).json({
      success: false,
      error: {
        code: "DUPLICATE",
        message: `This 1688 URL was submitted within the last ${TTL.DEDUP_LOCK / 60} minutes. Skipping duplicate.`,
        retryable: false,
      },
      correlationId: req.correlationId,
    });
    return;
  }

  // Store token in res.locals for release after processing
  (res as Response & { locals: Record<string, unknown> }).locals = {
    ...(res as Response & { locals: Record<string, unknown> }).locals,
    dedupLockToken: token,
    dedupLockUrl: url,
  };

  next();
}

/** Release dedup lock after successful or failed processing */
export async function releaseDedupLock(res: Response): Promise<void> {
  const locals = (res as Response & { locals: Record<string, unknown> }).locals || {};
  const token = locals.dedupLockToken as string | undefined;
  const url = locals.dedupLockUrl as string | undefined;
  if (token && url) {
    // Match the key format used by lockDedupListing: url.trim().toLowerCase().slice(0, 64)
    const { unlock } = await import("../services/redis-lock.js");
    const scope = `dedup:listing:${url.trim().toLowerCase().slice(0, 64)}`;
    await unlock(scope, token);
  }
}
