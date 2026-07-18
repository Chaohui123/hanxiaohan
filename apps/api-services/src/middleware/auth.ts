// ============================================================
// API Key Authentication Middleware
// Phase 1: Shared secret via API_KEY env var with optional multi-key support
// Phase 2: Per-store API keys, JWT, role-based access (planned)
//
// Multi-key: set API_KEYS=key1,key2,key3 for service-specific keys.
// Rotate keys by adding new ones, then removing old ones after migration.
// ============================================================

import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

/** Primary API key (backward compat) */
const API_KEY = process.env.API_KEY || "";

/**
 * Multi-key support: comma-separated list of valid API keys.
 * Each service (dashboard, promo-agent, ops-agent, n8n) can have its own key.
 * Set API_KEYS=key_for_dashboard,key_for_promo,key_for_ops,key_for_n8n
 * The primary API_KEY is always included in the valid set.
 */
const API_KEYS: Set<string> = new Set(
  (process.env.API_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
);
if (API_KEY) API_KEYS.add(API_KEY);

const PUBLIC_PATHS = [
  "/",
  "/health",
  "/health/light",
  "/api/health",
  "/ready",
  "/ready/pipeline",
  "/api/webhook/ozon",
  "/api/v1/webhook/ozon",
];

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + "/"));
}

function constantTimeCompare(a: string, b: string): boolean {
  // Use Buffer.from for correct UTF-8 byte length (String.length counts UTF-16 code units,
  // which can be smaller than the UTF-8 byte count for non-ASCII characters).
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  const maxLen = Math.max(bufA.length, bufB.length);
  const paddedA = Buffer.alloc(maxLen, 0);
  const paddedB = Buffer.alloc(maxLen, 0);
  bufA.copy(paddedA);
  bufB.copy(paddedB);
  return crypto.timingSafeEqual(paddedA, paddedB) && a.length === b.length;
}

function isValidToken(token: string): boolean {
  for (const validKey of API_KEYS) {
    if (constantTimeCompare(token, validKey)) return true;
  }
  return false;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (isPublicPath(req.path)) {
    next();
    return;
  }

  // Dev mode skips auth (must be explicitly set to "dev")
  if ((process.env.ENV || process.env.NODE_ENV) === "dev") {
    next();
    return;
  }

  // No keys configured
  if (API_KEYS.size === 0) {
    if ((process.env.ENV || process.env.NODE_ENV) === "production") {
      res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Server misconfigured: API_KEY not set", retryable: false },
        correlationId: (req as Request & { correlationId?: string }).correlationId ?? "unknown",
      });
      return;
    }
    // Non-production without keys: allow but warn
    next();
    return;
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : (req.headers["x-api-key"] as string) || "";

  if (!token || !isValidToken(token)) {
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

/**
 * Get the number of configured API keys (for health check).
 */
export function getApiKeyCount(): number {
  return API_KEYS.size;
}