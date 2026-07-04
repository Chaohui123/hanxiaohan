// ============================================================
// E2E Integration Tests — Full 1688→Ozon pipeline
// Mocks external services to test pipeline orchestration,
// error handling, and middleware stack end-to-end.
// ============================================================

import { describe, it, expect, vi } from "vitest";
import request from "supertest";

// ---- Mock external modules before importing the app ----
vi.mock("@onzo/scraper-1688", () => ({
  ProductScraper: vi.fn().mockImplementation(() => ({
    scrapeProduct: vi.fn().mockResolvedValue({
      sourceUrl: "https://detail.1688.com/offer/test.html",
      scrapeTimestamp: "2026-07-04T00:00:00Z",
      title: "测试商品 蓝牙耳机",
      price: { currentMin: 25, currentMax: 30, currency: "CNY" },
      specImages: ["https://img.example.com/1.jpg", "https://img.example.com/2.jpg"],
      detailImages: ["https://img.example.com/d1.jpg"],
      specifications: [
        { name: "颜色", value: "黑色" },
        { name: "材质", value: "ABS" },
      ],
      descriptionText: "高品质蓝牙耳机，降噪，长续航",
      categoryPath: ["数码", "耳机", "蓝牙耳机"],
      salesInfo: {},
    }),
    downloadImages: vi.fn().mockResolvedValue([
      { url: "https://img.example.com/1.jpg", buffer: Buffer.from("fake"), contentType: "image/jpeg" },
    ]),
    downloadImagesViaBrowser: vi.fn().mockResolvedValue([
      { url: "https://img.example.com/1.jpg", buffer: Buffer.from("fake"), contentType: "image/jpeg" },
    ]),
    filterProductImages: vi.fn().mockImplementation((urls: string[]) => urls.filter((u: string) => u.includes("img.example.com") || u.includes("cbu01"))),
    close: vi.fn().mockResolvedValue(undefined),
  })),
  BrowserPool: vi.fn().mockImplementation(() => ({
    acquire: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  })),
}));

vi.mock("@onzo/glm-integration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@onzo/glm-integration")>();
  return {
    ...actual, // preserve all prompt exports (buildTranslationPrompt, etc.)
    GlmVisionClient: vi.fn().mockImplementation(() => ({
      extractTextFromImages: vi.fn().mockResolvedValue([{ rawText: "蓝牙5.3 降噪" }]),
    })),
    DeepSeekClient: vi.fn().mockImplementation(() => ({
      chatCompletion: vi.fn().mockImplementation((opts: { messages: Array<{ role: string; content: string }> }) => {
        const userMsg = opts.messages.find((m) => m.role === "user")?.content ?? "";

        // Match attribute-fill requests (they contain "REQUIRED ATTRIBUTES for category")
        if (userMsg.includes("REQUIRED ATTRIBUTES")) {
          return Promise.resolve({
            content: '{"attributes":[{"attributeId":1,"name":"Цвет","value":"Черный"},{"attributeId":2,"name":"Материал","value":"ABS"}],"confidence":0.9,"missingRequired":[]}',
            parsed: { attributes: [{ attributeId: 1, name: "Цвет", value: "Черный" }, { attributeId: 2, name: "Материал", value: "ABS" }], confidence: 0.9, missingRequired: [] },
            tokensUsed: { prompt: 60, completion: 30, total: 90 },
            model: "deepseek-v4-flash",
          });
        }

        // Match category-match requests (they contain formatCategoryTree output with "categoryId" brackets)
        if (userMsg.includes("[") && (userMsg.includes("categoryId") || userMsg.includes("TV"))) {
          return Promise.resolve({
            content: '{"categoryId":300,"categoryName":"Bluetooth наушники","categoryPath":["Электроника","Наушники"],"confidence":0.9}',
            parsed: { categoryId: 300, categoryName: "Bluetooth наушники", categoryPath: ["Электроника","Наушники"], confidence: 0.9 },
            tokensUsed: { prompt: 80, completion: 40, total: 120 },
            model: "deepseek-v4-flash",
          });
        }

        // Default: translation response
        return Promise.resolve({
          content: '{"titleRu":"Тестовый товар Bluetooth наушники","descriptionRu":"Качественные Bluetooth наушники с шумоподавлением","specificationsRu":[{"name":"Цвет","value":"Черный"},{"name":"Материал","value":"ABS"}]}',
          parsed: { titleRu: "Тестовый товар Bluetooth наушники", descriptionRu: "Качественные Bluetooth наушники с шумоподавлением", specificationsRu: [{ name: "Цвет", value: "Черный" }, { name: "Материал", value: "ABS" }] },
          tokensUsed: { prompt: 100, completion: 50, total: 150 },
          model: "deepseek-v4-flash",
        });
      }),
    })),
    GlmRateLimiter: vi.fn().mockImplementation(() => ({
      call: vi.fn().mockImplementation((fn: () => Promise<unknown>) => fn()),
      acquire: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    })),
    TokenTracker: vi.fn().mockImplementation(() => ({
      checkLimit: vi.fn(),
      record: vi.fn().mockResolvedValue(true),
      getTodayUsage: vi.fn().mockReturnValue(0),
    })),
    estimateCost: vi.fn().mockReturnValue(0.001),
  };
});

vi.mock("@onzo/ozon-api-wrapper", () => ({
  OzonClient: vi.fn().mockImplementation(() => ({
    get apiBaseUrl() { return "https://api-seller.ozon.ru"; },
    getCategoryTree: vi.fn().mockResolvedValue([
      { categoryId: 100, title: "Электроника", children: [
        { categoryId: 200, title: "Наушники", children: [
          { categoryId: 300, title: "Bluetooth наушники", children: [] },
        ]},
      ]},
    ]),
    getCategoryAttributes: vi.fn().mockResolvedValue([
      { id: 1, name: "Цвет", type: "string", isRequired: true, isCollection: false },
      { id: 2, name: "Материал", type: "string", isRequired: true, isCollection: false },
    ]),
    importImageByUrl: vi.fn().mockResolvedValue({ id: "img-001", fileName: "1.jpg", url: "" }),
    importImageByUrlSoft: vi.fn().mockResolvedValue({ id: "img-001", fileName: "1.jpg", url: "" }),
    uploadLocalImageFile: vi.fn().mockResolvedValue({ id: "img-002", fileName: "2.jpg", url: "" }),
    resetBreaker: vi.fn(),
    createDraft: vi.fn().mockResolvedValue({ productId: 12345, offerId: "OFFER-001", status: "draft" }),
    ping: vi.fn().mockResolvedValue(true),
  })),
  AuthManager: vi.fn().mockImplementation(() => ({
    getHeaders: vi.fn().mockReturnValue({ "Client-Id": "test", "Api-Key": "test" }),
  })),
}));

vi.mock("@onzo/ozon-order", () => ({
  OzonOrderClient: vi.fn(),
  syncOrders: vi.fn().mockResolvedValue({ fbsCount: 0, fboCount: 0, total: 0, upserted: 0, skipped: 0, errors: [] }),
}));

vi.mock("@onzo/ozon-order/webhook", () => ({
  parseWebhookPayload: vi.fn(),
  handleWebhookEvent: vi.fn(),
}));

vi.mock("@onzo/validation-layer", () => ({
  ProductValidator: vi.fn().mockImplementation(() => ({
    validate: vi.fn().mockReturnValue({
      valid: true,
      errors: [],
      warnings: [],
      stats: { totalChecks: 16, passed: 16, failed: 0, warned: 0 },
    }),
  })),
}));

// Set required env vars before importing app
process.env.OZON_CLIENT_IDS = "test-client";
process.env.OZON_API_KEYS = "test-key";
process.env.GLM_API_KEY = "test-glm";
process.env.DEEPSEEK_API_KEY = "test-ds";
process.env.ENV = "dev";

import { app } from "../src/index.js";

describe("Pipeline E2E", () => {
  // ---- Full successful pipeline (async) ----
  it("POST /api/process returns 202 and enqueues task", async () => {
    const res = await request(app)
      .post("/api/process")
      .send({ url: "https://detail.1688.com/offer/e2e-async-test.html" });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.data.taskId).toBeDefined();
    expect(res.body.data.status).toBe("queued");
  });

  // ---- Synchronous pipeline ----
  it("POST /api/process/sync returns full product data", async () => {
    const res = await request(app)
      .post("/api/process/sync")
      .send({ url: "https://detail.1688.com/offer/e2e-sync-test.html" });

    // If something goes wrong, debug the response
    if (res.status !== 200) {
      console.error("SYNC ERROR BODY:", JSON.stringify(res.body, null, 2));
    }

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.taskId).toBeDefined();
    expect(res.body.data.draftId).toBe("OFFER-001");
    expect(res.body.data.ozonProductId).toBe(12345);
    expect(res.body.data.priceRub).toBeGreaterThan(0);
  });

  // ---- Missing URL validation ----
  it("POST /api/process returns 400 for missing url", async () => {
    const res = await request(app)
      .post("/api/process")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("MISSING_URL");
  });

  // ---- Health check ----
  it("GET /health returns ok", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.uptime).toBeGreaterThan(0);
  });

  // ---- Dashboard ----
  it("GET /api/dashboard returns queue stats", async () => {
    const res = await request(app).get("/api/dashboard");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.queue).toBeDefined();
  });

  // ---- Queue stats ----
  it("GET /api/task/queue/stats returns queue counts", async () => {
    const res = await request(app).get("/api/task/queue/stats");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.queued).toBe("number");
  });

  // ---- Duplicate idempotency ----
  it("POST /api/process rejects duplicate URL within 5 min", async () => {
    await request(app)
      .post("/api/process")
      .send({ url: "https://detail.1688.com/offer/dup-test.html" });

    const res = await request(app)
      .post("/api/process")
      .send({ url: "https://detail.1688.com/offer/dup-test.html" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DUPLICATE");
  });

  // ---- Manual input pipeline ----
  it("POST /api/process/manual skips scraper and creates draft", async () => {
    const res = await request(app)
      .post("/api/process/manual")
      .send({
        title: "Test Product Manual Input",
        priceCny: 30,
        specImages: ["https://img.example.com/m1.jpg"],
        detailImages: [],
        specifications: [{ name: "Color", value: "Black" }],
        descriptionText: "A test product for manual pipeline",
      });

    if (res.status !== 200) {
      console.error("MANUAL ERROR BODY:", JSON.stringify(res.body, null, 2));
    }

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.draftId).toBe("OFFER-001");
  });

  // ---- Backup endpoint (may fail without DB, should not crash) ----
  it("POST /api/db/backup does not crash", async () => {
    const res = await request(app)
      .post("/api/db/backup")
      .send({});

    expect([200, 500, 503]).toContain(res.status);
  });

  // ---- Correlation ID propagation ----
  it("GET /health includes timestamp", async () => {
    const res = await request(app).get("/health");

    expect(res.body.timestamp).toBeDefined();
    expect(res.body.status).toBe("ok");
  });
});
