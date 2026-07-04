// ============================================================
// API Key Authentication Middleware
// Phase 1: Shared secret via API_KEY env var
// Phase 2: Per-store API keys, JWT, role-based access
// ============================================================

import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const API_KEY = process.env.API_KEY || "";

const PUBLIC_PATHS = [
  "/health",
  "/ready",
  "/api/webhook/ozon",
];

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + "/"));
}

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (isPublicPath(req.path)) {
    next();
    return;
  }

  if ((process.env.ENV || process.env.NODE_ENV) === "dev") {
    next();
    return;
  }

  if (!API_KEY) {
    next();
    return;
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : (req.headers["x-api-key"] as string) || "";

  if (!token || !constantTimeCompare(token, API_KEY)) {
    res.status(401).json({
      success: false,
      error: {
        code: "UNAUTHORIZED",
        message: "Invalid or missing API key. Use Authorization: Bearer <key> or X-API-Key header.",
        retryable: false,
      },
      correlationId: (req as Request & { correlationId?: string }).correlationId ?? "unknown",
    });
    return;
  }

  next();
}