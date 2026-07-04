// ============================================================
// Request Timing Middleware — logs response time for every request
// Emits structured metrics: method, path, status, durationMs
// ============================================================

import type { Request, Response, NextFunction } from "express";
import { logger } from "@onzo/logger";

export function requestTimingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on("finish", () => {
    const durationMs = Date.now() - start;
    const level = res.statusCode >= 500 ? "warn" : res.statusCode >= 400 ? "info" : "debug";

    logger[level](
      {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs,
        correlationId: req.correlationId,
      },
      `${req.method} ${req.path} ${res.statusCode} ${durationMs}ms`
    );
  });

  next();
}
