// ============================================================
// Access Log Middleware — lightweight request logging
// Logs method, path, status, duration, correlationId.
// Skips high-frequency monitoring endpoints (/health, /metrics, etc.)
// ============================================================

import type { Request, Response, NextFunction } from "express";
import { logger } from "@onzo/logger";

const SKIP_PATHS = [
  "/health",
  "/ready",
  "/ready/pipeline",
  "/metrics",
  "/api/docs",
];

function shouldSkip(path: string): boolean {
  return SKIP_PATHS.some((p) => path === p || path.startsWith(p + "/"));
}

export function accessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on("finish", () => {
    if (shouldSkip(req.path)) return;

    logger.info({
      type: "access",
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - start,
      correlationId: (req as Request & { correlationId?: string }).correlationId ?? "unknown",
      userId: (req as Request & { userId?: string }).userId,
    });
  });

  next();
}
