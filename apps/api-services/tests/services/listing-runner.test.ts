// ============================================================
// Listing Runner Tests — services/listing-runner.ts
// Verifies orchestration + outcome mapping of the shared pipeline runner.
// All step functions and external services are mocked.
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ListingInfra } from "../../src/services/listing-runner.js";

const mocks = vi.hoisted(() => ({
  stepScrape: vi.fn(),
  stepOcr: vi.fn().mockResolvedValue([]),
  stepTranslate: vi.fn().mockResolvedValue({ titleRu: "Тест", descriptionRu: "Описание", specificationsRu: [] }),
  stepMatchCategory: vi.fn().mockResolvedValue({ categoryId: 300, categoryName: "Earbuds", categoryPath: ["Electronics"] }),
  stepFillAttributes: vi.fn().mockResolvedValue([]),
  stepDownloadAndUploadImages: vi.fn().mockResolvedValue(["img-1"]),
  stepCreateDraft: vi.fn().mockResolvedValue({ productId: 123, offerId: "OFFER-1" }),
  stepOpsReview: vi.fn().mockResolvedValue({ approved: true, riskLevel: "low", suggestions: [] }),
  buildProcessedProduct: vi.fn().mockReturnValue({
    titleRu: "Тест", descriptionRu: "Описание", categoryId: 300, categoryName: "Earbuds",
    categoryPath: ["Electronics"], priceRub: 100, attributes: [], specificationsRu: [],
    dimensionsCm: { length: 20, width: 15, height: 5 }, weightKg: 0.5, imageIds: ["img-1"],
  }),
  getCategoryTree: vi.fn().mockResolvedValue([{ categoryId: 300, title: "Earbuds", children: [] }]),
  getExchangeRate: vi.fn().mockResolvedValue({ rate: 11.5, cached: true, stale: false, reliable: true, source: "test" }),
  checkChineseProductCompliance: vi.fn().mockReturnValue({ blocked: false, warnings: [], requiredCerts: [] }),
  fullComplianceCheck: vi.fn().mockReturnValue({ blocked: false, warnings: [] }),
}));

vi.mock("../../src/pipelines/listing-pipeline.js", () => ({
  createPipelineContext: (url: string, storeId = "store_1") => ({
    taskId: "ctx-task-1", correlationId: "ctx-corr-1", storeId, sourceUrl: url, errors: [],
  }),
  stepScrape: mocks.stepScrape,
  stepOcr: mocks.stepOcr,
  stepTranslate: mocks.stepTranslate,
  stepMatchCategory: mocks.stepMatchCategory,
  stepFillAttributes: mocks.stepFillAttributes,
  stepDownloadAndUploadImages: mocks.stepDownloadAndUploadImages,
  stepCreateDraft: mocks.stepCreateDraft,
  stepOpsReview: mocks.stepOpsReview,
  buildProcessedProduct: mocks.buildProcessedProduct,
}));
vi.mock("../../src/services/category-cache.js", () => ({ getCategoryTree: mocks.getCategoryTree }));
vi.mock("../../src/services/exchange-rate.js", () => ({ getExchangeRate: mocks.getExchangeRate, forceRefreshRate: vi.fn() }));
vi.mock("../../src/services/compliance.js", () => ({
  checkChineseProductCompliance: mocks.checkChineseProductCompliance,
  fullComplianceCheck: mocks.fullComplianceCheck,
}));
vi.mock("../../src/services/notifier.js", () => ({ notifier: { notify: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("../../src/middleware/shutdown.js", () => ({ registerCleanup: vi.fn() }));
vi.mock("@onzo/scraper-1688", () => ({ ProductScraper: vi.fn(), BrowserPool: vi.fn() }));
vi.mock("@onzo/ozon-api-wrapper", () => ({ OzonClient: vi.fn(), AuthManager: vi.fn() }));
vi.mock("@onzo/validation-layer", () => ({ ProductValidator: vi.fn() }));
vi.mock("@onzo/glm-integration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@onzo/glm-integration")>();
  return {
    ...actual,
    GlmVisionClient: vi.fn(),
    DeepSeekClient: vi.fn(),
    GlmRateLimiter: vi.fn(),
    TokenTracker: vi.fn(),
    estimateCost: vi.fn().mockReturnValue(0),
  };
});

import { runListingPipeline } from "../../src/services/listing-runner.js";

const scrapedFixture = {
  sourceUrl: "https://detail.1688.com/offer/1.html",
  scrapeTimestamp: new Date().toISOString(),
  title: "Test Product",
  price: { currentMin: 10, currentMax: 20, currency: "CNY" },
  specImages: ["https://img.example.com/1.jpg"],
  detailImages: [],
  specifications: [],
  descriptionText: "A test product",
  categoryPath: ["Electronics"],
};

function makeInfra() {
  return {
    browserPool: { acquire: vi.fn().mockResolvedValue(undefined), release: vi.fn() },
    scraper: {},
    validator: { validate: vi.fn().mockReturnValue({ valid: true, errors: [], warnings: [] }) },
    ozonClient: { getCategoryAttributes: vi.fn().mockResolvedValue([]) },
    glmLimiter: { call: vi.fn((fn: () => Promise<unknown>) => fn()) },
    visionClient: {},
    deepseekClient: {},
    deepseekTranslator: {},
    tokenTracker: {},
  };
}

describe("runListingPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks only resets call history — re-apply default implementations
    mocks.checkChineseProductCompliance.mockReturnValue({ blocked: false, warnings: [], requiredCerts: [] });
    mocks.fullComplianceCheck.mockReturnValue({ blocked: false, warnings: [] });
    mocks.getExchangeRate.mockResolvedValue({ rate: 11.5, cached: true, stale: false, reliable: true, source: "test" });
    mocks.stepOpsReview.mockResolvedValue({ approved: true, riskLevel: "low", suggestions: [] });
    mocks.stepScrape.mockImplementation(async (ctx: { scraped?: unknown }) => {
      ctx.scraped = scrapedFixture;
      return scrapedFixture;
    });
  });

  it("runs the full pipeline and returns a success outcome", async () => {
    const infra = makeInfra();
    const { ctx, outcome } = await runListingPipeline(infra as unknown as ListingInfra, {
      url: "https://detail.1688.com/offer/1.html", storeId: "store_1",
    });

    expect(outcome).toEqual({ kind: "success", productId: 123, offerId: "OFFER-1", titleRu: "Тест" });
    expect(infra.browserPool.acquire).toHaveBeenCalled();
    expect(infra.browserPool.release).toHaveBeenCalled();
    expect(mocks.stepOcr).toHaveBeenCalled();
    expect(mocks.stepTranslate).toHaveBeenCalled();
    expect(mocks.stepMatchCategory).toHaveBeenCalled();
    expect(mocks.stepDownloadAndUploadImages).toHaveBeenCalled();
    expect(mocks.stepOpsReview).toHaveBeenCalled();
    expect(mocks.stepCreateDraft).toHaveBeenCalled();
    expect(ctx.sourceUrl).toBe("https://detail.1688.com/offer/1.html");
  });

  it("fills attributes when Ozon returns required attributes", async () => {
    const infra = makeInfra();
    infra.ozonClient.getCategoryAttributes.mockResolvedValue([{ id: 1, name: "Color", isRequired: true }]);

    const { outcome } = await runListingPipeline(infra as unknown as ListingInfra, {
      url: "https://detail.1688.com/offer/1.html",
    });

    expect(infra.ozonClient.getCategoryAttributes).toHaveBeenCalledWith(300);
    expect(mocks.stepFillAttributes).toHaveBeenCalled();
    expect(outcome.kind).toBe("success");
  });

  it("continues without attributes when getCategoryAttributes fails", async () => {
    const infra = makeInfra();
    infra.ozonClient.getCategoryAttributes.mockRejectedValue(new Error("ozon down"));

    const { outcome } = await runListingPipeline(infra as unknown as ListingInfra, {
      url: "https://detail.1688.com/offer/1.html",
    });

    expect(mocks.stepFillAttributes).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("success");
  });

  it("blocks on Chinese compliance before OCR", async () => {
    mocks.checkChineseProductCompliance.mockReturnValue({ blocked: true, blockedReason: "Requires CCC", warnings: [], requiredCerts: ["CCC"] });
    const infra = makeInfra();

    const { outcome } = await runListingPipeline(infra as unknown as ListingInfra, {
      url: "https://detail.1688.com/offer/1.html",
    });

    expect(outcome).toEqual({ kind: "blocked", blockKind: "cn_compliance", reason: "Requires CCC" });
    expect(mocks.stepOcr).not.toHaveBeenCalled();
  });

  it("blocks when the exchange rate is unreliable", async () => {
    mocks.getExchangeRate.mockResolvedValue({ rate: 0, cached: false, stale: true, reliable: false, source: "fallback" });
    const infra = makeInfra();

    const { outcome } = await runListingPipeline(infra as unknown as ListingInfra, {
      url: "https://detail.1688.com/offer/1.html",
    });

    expect(outcome.kind).toBe("blocked");
    if (outcome.kind === "blocked") {
      expect(outcome.blockKind).toBe("fx_unreliable");
      expect(outcome.reason).toContain("Exchange rate unreliable");
    }
    expect(mocks.stepCreateDraft).not.toHaveBeenCalled();
  });

  it("blocks on product validation failure", async () => {
    const infra = makeInfra();
    infra.validator.validate.mockReturnValue({ valid: false, errors: [{ message: "title too short" }], warnings: [] });

    const { outcome } = await runListingPipeline(infra as unknown as ListingInfra, {
      url: "https://detail.1688.com/offer/1.html",
    });

    expect(outcome).toEqual({ kind: "blocked", blockKind: "validation", reason: "Validation: title too short" });
    expect(mocks.stepCreateDraft).not.toHaveBeenCalled();
  });

  it("blocks on category compliance", async () => {
    mocks.fullComplianceCheck.mockReturnValue({ blocked: true, blockedReason: "Category prohibited", warnings: [] });
    const infra = makeInfra();

    const { outcome } = await runListingPipeline(infra as unknown as ListingInfra, {
      url: "https://detail.1688.com/offer/1.html",
    });

    expect(outcome).toEqual({ kind: "blocked", blockKind: "compliance", reason: "Compliance: Category prohibited" });
    expect(mocks.stepCreateDraft).not.toHaveBeenCalled();
  });

  it("blocks when ops review rejects the listing", async () => {
    mocks.stepOpsReview.mockResolvedValue({ approved: false, reason: "Price anomaly", riskLevel: "high", suggestions: [] });
    const infra = makeInfra();

    const { outcome } = await runListingPipeline(infra as unknown as ListingInfra, {
      url: "https://detail.1688.com/offer/1.html",
    });

    expect(outcome).toEqual({ kind: "blocked", blockKind: "ops_review", reason: "Price anomaly" });
    expect(mocks.stepCreateDraft).not.toHaveBeenCalled();
  });

  it("returns an error outcome when a step throws (and still releases the browser)", async () => {
    mocks.stepScrape.mockRejectedValue(new Error("scrape timeout"));
    const infra = makeInfra();

    const { outcome } = await runListingPipeline(infra as unknown as ListingInfra, {
      url: "https://detail.1688.com/offer/1.html",
    });

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.error.message).toBe("scrape timeout");
    expect(infra.browserPool.release).toHaveBeenCalled();
  });

  it("overrides the pipeline correlation id when provided", async () => {
    const infra = makeInfra();

    const { ctx } = await runListingPipeline(infra as unknown as ListingInfra, {
      url: "https://detail.1688.com/offer/1.html", correlationId: "queue-corr-9",
    });

    expect(ctx.correlationId).toBe("queue-corr-9");
  });
});
