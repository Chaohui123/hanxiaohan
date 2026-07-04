// ============================================================
// Mock Middleware — ENV=dev 时拦截外部 API 调用
// 不消耗线上额度，不创建真实 Ozon 草稿
// ============================================================

import type { Request, Response, NextFunction } from "express";

const IS_DEV = (process.env.ENV || process.env.NODE_ENV) === "dev";

// Secondary check: require explicit ENABLE_MOCK=true even in dev mode
// Prevents accidentally running mock mode in staging/production-like environments
const MOCK_ENABLED = process.env.ENABLE_MOCK === "true";

export function mockMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!IS_DEV || !MOCK_ENABLED) {
    next();
    return;
  }

  // Mock Ozon product creation
  if (req.path === "/api/process/sync" || req.path === "/api/process/manual") {
    console.warn(`[MOCK] Returning fake response for ${req.path} — ENV=dev + ENABLE_MOCK=true`);
    res.json({
      success: true,
      data: {
        taskId: `mock-${Date.now()}`,
        draftId: `mock-draft-${Date.now()}`,
        ozonProductId: Math.floor(Math.random() * 100000),
        titleRu: "[DEV MOCK] Тестовый товар",
        categoryName: "[DEV MOCK] Электроника / Аксессуары",
        priceRub: 1500,
        imagesUploaded: 1,
      },
      correlationId: req.correlationId ?? "mock",
      _mock: true,
    });
    return;
  }

  // Mock Ozon API calls
  if (req.path.startsWith("/api/debug")) {
    console.warn(`[MOCK] Returning fake response for ${req.path}`);
    res.json({
      success: true,
      data: { title: "[DEV MOCK] Product", price: { currentMin: 10, currentMax: 20, currency: "CNY" }, specImages: [], specifications: [], _mock: true },
      correlationId: req.correlationId ?? "mock",
    });
    return;
  }

  next();
}
