// ============================================================
// Audit Middleware — logs all mutating requests for compliance
// ============================================================

import type { Request, Response, NextFunction } from "express";
import { logger } from "@onzo/logger";

const AUDIT_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

export function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (AUDIT_METHODS.includes(req.method)) {
    const originalEnd = res.end;
    res.end = function (...args: unknown[]) {
      logger.info({
        audit: true,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
        userAgent: req.headers["user-agent"],
        correlationId: (req as Request & { correlationId?: string }).correlationId,
      }, "API audit");
      return (originalEnd as Function).apply(res, args);
    };
  }
  next();
}
