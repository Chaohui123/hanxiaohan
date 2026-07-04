// ============================================================
// E2E Integration Tests — Full 1688→Ozon Pipeline
// Tests: full flow, error handling, concurrency, idempotency
// ============================================================

import { describe, it, expect, vi } from "vitest";
import request from "supertest";

// ---- Mock external modules ----
vi.mock("@onzo/scraper-1688", () => ({
  ProductScraper: vi.fn().mockImplementation(() => ({
    scrapeProduct: vi.fn().mockResolvedValue({
      sourceUrl: "https://detail.1688.com/offer/test.html",
      title: "Test Bluetooth Earbuds",
      price: { currentMin: 25, currentMax: 30, currency: "CNY" },
      specImages: ["https://img.example.com/1.jpg", "https://img.example.com/2.jpg"],
      detailImages: ["https://img.example.com/d1.jpg"],
      specifications: [{ name: "Color", value: "Black" }, { name: "Material", value: "ABS" }],
      descriptionText: "High quality Bluetooth earbuds with noise cancelling",
      categoryPath: ["Electronics", "Audio", "Bluetooth"],
      salesInfo: {},
      scrapeTimestamp: new Date().toISOString(),
    }),
    downloadImages: vi.fn().mockResolvedValue([{ url: "https://img.example.com/1.jpg", buffer: Buffer.from("fake"), contentType: "image/jpeg" }]),
    downloadImagesViaBrowser: vi.fn().mockResolvedValue([{ url: "https://img.example.com/1.jpg", buffer: Buffer.from("fake"), contentType: "image/jpeg" }]),
    filterProductImages: vi.fn().mockImplementation((urls: string[]) => urls.filter((u: string) => /\.(jpg|png|webp)/i.test(u))),
    close: vi.fn().mockResolvedValue(undefined),
    onCaptcha: vi.fn(),
    getMetrics: vi.fn().mockReturnValue({ totalRequests: 0, successRequests: 0, failedRequests: 0, captchaTriggers: 0, successRate: "N/A" }),
  })),
  BrowserPool: vi.fn().mockImplementation(() => ({
    acquire: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  })),
}));

vi.mock("@onzo/glm-integration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@onzo/glm-integration")>();
  return {
    ...actual,
    GlmVisionClient: vi.fn().mockImplementation(() => ({
      extractTextFromImages: vi.fn().mockResolvedValue([{ rawText: "Bluetooth 5.3 ANC" }]),
    })),
    DeepSeekClient: vi.fn().mockImplementation(() => ({
      chatCompletion: vi.fn().mockImplementation((opts: { messages: Array<{ role: string; content: string }> }) => {
        const userMsg = opts.messages.find((m) => m.role === "user")?.content ?? "";
        if (userMsg.includes("REQUIRED ATTRIBUTES")) {
          return Promise.resolve({ content: '{"attributes":[{"attributeId":1,"name":"Color","value":"Black"},{"attributeId":2,"name":"Material","value":"ABS"}]}', parsed: { attributes: [{ attributeId: 1, name: "Color", value: "Black" }, { attributeId: 2, name: "Material", value: "ABS" }] }, tokensUsed: { prompt: 60, completion: 30, total: 90 }, model: "deepseek-v4-flash" });
        }
        if (userMsg.includes("[") && userMsg.includes("categoryId")) {
          return Promise.resolve({ content: '{"categoryId":300,"categoryName":"Bluetooth Earbuds","categoryPath":["Electronics","Audio","Bluetooth"],"confidence":0.9}', parsed: { categoryId: 300, categoryName: "Bluetooth Earbuds", categoryPath: ["Electronics", "Audio", "Bluetooth"], confidence: 0.9 }, tokensUsed: { prompt: 80, completion: 40, total: 120 }, model: "deepseek-v4-flash" });
        }
        return Promise.resolve({ content: '{"titleRu":"Bluetooth наушники","descriptionRu":"Качественные Bluetooth наушники с шумоподавлением","specificationsRu":[{"name":"Color","value":"Black"},{"name":"Material","value":"ABS"}]}', parsed: { titleRu: "Bluetooth наушники", descriptionRu: "Качественные Bluetooth наушники с шумоподавлением", specificationsRu: [{ name: "Color", value: "Black" }, { name: "Material", value: "ABS" }] }, tokensUsed: { prompt: 100, completion: 50, total: 150 }, model: "deepseek-v4-flash" });
      }),
    })),
    GlmRateLimiter: vi.fn().mockImplementation(() => ({ call: vi.fn().mockImplementation((fn: () => Promise<unknown>) => fn()), acquire: vi.fn().mockResolvedValue(undefined), release: vi.fn() })),
    TokenTracker: vi.fn().mockImplementation(() => ({ checkLimit: vi.fn(), record: vi.fn().mockResolvedValue(true), getTodayUsage: vi.fn().mockReturnValue(0) })),
    estimateCost: vi.fn().mockReturnValue(0.001),
  };
});

vi.mock("@onzo/ozon-api-wrapper", () => ({
  OzonClient: vi.fn().mockImplementation(() => ({
    get apiBaseUrl() { return "https://api-seller.ozon.ru"; },
    getCategoryTree: vi.fn().mockResolvedValue([{ categoryId: 100, title: "Electronics", children: [{ categoryId: 200, title: "Audio", children: [{ categoryId: 300, title: "Bluetooth Earbuds", children: [] }] }] }]),
    getCategoryAttributes: vi.fn().mockResolvedValue([{ id: 1, name: "Color", type: "string", isRequired: true }, { id: 2, name: "Material", type: "string", isRequired: true }]),
    importImageByUrl: vi.fn().mockResolvedValue({ id: "img-001", fileName: "1.jpg", url: "" }),
    importImageByUrlSoft: vi.fn().mockResolvedValue({ id: "img-001", fileName: "1.jpg", url: "" }),
    uploadLocalImageFile: vi.fn().mockResolvedValue({ id: "img-002", fileName: "2.jpg", url: "" }),
    createDraft: vi.fn().mockResolvedValue({ productId: 12345, offerId: "OFFER-001", status: "draft" }),
    ping: vi.fn().mockResolvedValue(true),
    resetBreaker: vi.fn(),
  })),
  AuthManager: vi.fn().mockImplementation(() => ({ getHeaders: vi.fn().mockReturnValue({ "Client-Id": "test", "Api-Key": "test" }) })),
}));

vi.mock("@onzo/ozon-order", () => ({ OzonOrderClient: vi.fn(), syncOrders: vi.fn().mockResolvedValue({ fbsCount: 0, fboCount: 0, total: 0, upserted: 0, skipped: 0, errors: [] }) }));
vi.mock("@onzo/ozon-order/webhook", () => ({ parseWebhookPayload: vi.fn(), handleWebhookEvent: vi.fn() }));
vi.mock("@onzo/validation-layer", () => ({ ProductValidator: vi.fn().mockImplementation(() => ({ validate: vi.fn().mockReturnValue({ valid: true, errors: [], warnings: [], stats: { totalChecks: 16, passed: 16, failed: 0, warned: 0 } }) })) }));
vi.mock("@onzo/logistics", () => ({ getLogisticsProvider: vi.fn().mockResolvedValue(null), selectBestProvider: vi.fn().mockResolvedValue(null) }));
vi.mock("@onzo/cache", () => ({ cache: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined), del: vi.fn().mockResolvedValue(undefined), mget: vi.fn().mockResolvedValue([]), mset: vi.fn().mockResolvedValue(undefined), incr: vi.fn().mockResolvedValue(1), expire: vi.fn().mockResolvedValue(undefined), ping: vi.fn().mockResolvedValue(true), healthCheck: vi.fn().mockResolvedValue({ available: true, latencyMs: 1 }) } }));

process.env.OZON_CLIENT_IDS = "test";
process.env.OZON_API_KEYS = "test";
process.env.GLM_API_KEY = "test";
process.env.DEEPSEEK_API_KEY = "test";
process.env.ENV = "dev";

import { app } from "../src/index.js";

describe("Pipeline E2E", () => {
  // Full async pipeline
  it("POST /api/process — enqueues task and returns 202", async () => {
    const res = await request(app).post("/api/process").send({ url: "https://detail.1688.com/offer/e2e.html" });
    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.data.taskId).toBeDefined();
  });

  // Sync pipeline
  it("POST /api/process/sync — returns full product data", async () => {
    const res = await request(app).post("/api/process/sync").send({ url: "https://detail.1688.com/offer/sync-test.html" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.draftId).toBe("OFFER-001");
    expect(res.body.data.ozonProductId).toBe(12345);
    expect(res.body.data.priceRub).toBeGreaterThan(0);
  });

  // Error: missing URL
  it("POST /api/process — 400 on missing url", async () => {
    const res = await request(app).post("/api/process").send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_URL");
  });

  // Idempotency: duplicate URL
  it("POST /api/process — 409 on duplicate URL within 5 min", async () => {
    const dupUrl = "https://detail.1688.com/offer/dup-check.html";
    await request(app).post("/api/process").send({ url: dupUrl });
    const res = await request(app).post("/api/process").send({ url: dupUrl });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DUPLICATE");
  });

  // Concurrency: multiple products
  it("POST /api/process — handles concurrent submissions", async () => {
    const results = await Promise.all([
      request(app).post("/api/process").send({ url: "https://detail.1688.com/offer/conc-1.html" }),
      request(app).post("/api/process").send({ url: "https://detail.1688.com/offer/conc-2.html" }),
      request(app).post("/api/process").send({ url: "https://detail.1688.com/offer/conc-3.html" }),
    ]);
    for (const res of results) {
      expect(res.status).toBe(202);
      expect(res.body.data.taskId).toBeDefined();
    }
  });

  // Health
  it("GET /health — returns ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  // Dashboard
  it("GET /api/dashboard — returns queue stats", async () => {
    const res = await request(app).get("/api/dashboard");
    expect(res.status).toBe(200);
    expect(res.body.data.queue).toBeDefined();
  });

  // Manual pipeline
  it("POST /api/process/manual — skips scraper, creates draft", async () => {
    const res = await request(app).post("/api/process/manual").send({
      title: "Test Product Manual",
      priceCny: 30,
      specImages: ["https://img.example.com/manual.jpg"],
      specifications: [{ name: "Color", value: "Black" }],
      descriptionText: "Manual test product",
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.draftId).toBe("OFFER-001");
  });
});
