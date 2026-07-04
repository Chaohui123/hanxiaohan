// ============================================================
// API Key Authentication Middleware
// Phase 1: Shared secret via API_KEY env var
// Phase 2: Per-store API keys, JWT, role-based access
// ============================================================

import type { Request, Response, NextFunction } from "express";

const API_KEY = process.env.API_KEY || "";

// Paths that don't require authentication
const PUBLIC_PATHS = [
  "/health",
  "/ready",
  "/api/webhook/ozon", // Ozon pushes to this endpoint
];

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + "/"));
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip auth for public paths
  if (isPublicPath(req.path)) {
    next();
    return;
  }

  // In dev mode (ENV=dev), skip auth for convenience
  if ((process.env.ENV || process.env.NODE_ENV) === "dev") {
    next();
    return;
  }

  // If no API_KEY configured, auth is disabled (retrocompat)
  if (!API_KEY) {
    next();
    return;
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : (req.headers["x-api-key"] as string) || "";

  if (!token || token !== API_KEY) {
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
