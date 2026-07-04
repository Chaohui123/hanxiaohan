import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";

// Mock the cache module
vi.mock("@onzo/cache", () => ({ cache: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) } }));

import { idempotencyMiddleware } from "../../src/middleware/idempotency.js";

describe("idempotencyMiddleware", () => {
  function makeReq(path: string, url?: string) {
    return {
      path,
      body: url ? { url } : {},
      correlationId: "test",
    } as Request;
  }

  it("skips non-process paths", async () => {
    const req = makeReq("/api/dashboard");
    const res = { status: vi.fn().mockReturnValue({ json: vi.fn() }), json: vi.fn() } as unknown as Response;
    const next = vi.fn() as NextFunction;
    await idempotencyMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("skips when no URL in body", async () => {
    const req = makeReq("/api/process");
    const res = { status: vi.fn().mockReturnValue({ json: vi.fn() }), json: vi.fn() } as unknown as Response;
    const next = vi.fn() as NextFunction;
    await idempotencyMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("allows first request for a URL", async () => {
    const req = makeReq("/api/process", "https://detail.1688.com/offer/unique.html");
    const res = { status: vi.fn().mockReturnValue({ json: vi.fn() }), json: vi.fn() } as unknown as Response;
    const next = vi.fn() as NextFunction;
    await idempotencyMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
