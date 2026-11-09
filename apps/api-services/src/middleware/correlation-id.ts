// ============================================================
// Correlation ID middleware — propagates trace IDs across requests
// ============================================================

import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";

declare module "express-serve-static-core" {
  interface Request {
    correlationId: string;
  }
}

export function correlationIdMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  req.correlationId =
    (req.headers["x-correlation-id"] as string) ??
    crypto.randomUUID();
  next();
}
