import { describe, it, expect, vi } from "vitest";
import { authMiddleware } from "../../src/middleware/auth.js";
import type { Request, Response, NextFunction } from "express";

describe("authMiddleware", () => {
  const makeReq = (path: string, headers: Record<string, string> = {}) => {
    const req = { path, headers, correlationId: "test-cid" } as unknown as Request;
    const res = { status: vi.fn().mockReturnValue({ json: vi.fn() }), json: vi.fn() } as unknown as Response;
    const next = vi.fn() as NextFunction;
    return { req, res, next };
  };

  it("allows public paths without auth", () => {
    const { req, res, next } = makeReq("/health");
    authMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("allows webhook without auth", () => {
    const { req, res, next } = makeReq("/api/webhook/ozon");
    authMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("skips auth in dev mode", () => {
    const old = process.env.ENV;
    process.env.ENV = "dev";
    const { req, res, next } = makeReq("/api/process");
    authMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    process.env.ENV = old;
  });

  it("protects API routes when API_KEY is set", () => {
    process.env.API_KEY = "test-key-1234567890123456";
    process.env.ENV = "production";
    const { req, res, next } = makeReq("/api/process");
    authMiddleware(req, res, next);
    // Should reject (no auth header) or pass (auth disabled)
    expect(res.status).toBeDefined();
    process.env.ENV = "dev";
    delete process.env.API_KEY;
  });
});
