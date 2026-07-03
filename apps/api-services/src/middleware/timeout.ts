// ============================================================
// Global request timeout middleware (Express)
// ============================================================

import type { Request, Response, NextFunction } from "express";

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes

export function timeoutMiddleware(ms: number = DEFAULT_TIMEOUT_MS) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        res.status(504).json({
          success: false,
          error: { code: "TIMEOUT", message: `Request exceeded ${ms}ms timeout`, retryable: true },
        });
      }
    }, ms);

    res.on("finish", () => clearTimeout(timer));
    next();
  };
}
