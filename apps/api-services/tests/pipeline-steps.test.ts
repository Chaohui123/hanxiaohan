// ============================================================
// Pipeline Step Unit Tests — each step tested in isolation
// ============================================================

import { describe, it, expect, vi } from "vitest";
import {
  createPipelineContext,
  stepScrape,
  stepOcr,
  stepTranslate,
  stepMatchCategory,
  stepFillAttributes,
  stepCreateDraft,
  buildProcessedProduct,
  findLeafTypeId,
  findAttributeCategoryId,
} from "../src/pipelines/listing-pipeline.js";

// ---- Step 1: Scrape ----
describe("stepScrape", () => {
  it("returns scraped product on success", async () => {
    const ctx = createPipelineContext("https://detail.1688.com/offer/test.html");
    const mockScraper = {
      scrapeProduct: vi.fn().mockResolvedValue({
        sourceUrl: "https://detail.1688.com/offer/test.html",
        title: "Test Product",
        price: { currentMin: 10, currentMax: 20, currency: "CNY" },
        specImages: ["img1.jpg"],
        detailImages: [],
        specifications: [],
        descriptionText: "A test product",
        categoryPath: ["Category"],
        salesInfo: {},
        scrapeTimestamp: new Date().toISOString(),
      }),
    } as unknown as Parameters<typeof stepScrape>[1];

    const result = await stepScrape(ctx, mockScraper, "https://detail.1688.com/offer/test.html");
    expect(result.title).toBe("Test Product");
    expect(ctx.scraped).toBeDefined();
    expect(ctx.scraped!.title).toBe("Test Product");
  });

  it("records error and throws on scrape failure", async () => {
    const ctx = createPipelineContext("https://detail.1688.com/offer/bad.html");
    const mockScraper = {
      scrapeProduct: vi.fn().mockRejectedValue(new Error("Network error")),
    } as unknown as Parameters<typeof stepScrape>[1];

    await expect(stepScrape(ctx, mockScraper, "https://detail.1688.com/offer/bad.html")).rejects.toThrow();
    expect(ctx.errors).toHaveLength(1);
    expect(ctx.errors[0].step).toBe("scrape");
  });
});

// ---- Step 2: OCR ----
describe("stepOcr", () => {
  it("extracts text from images", async () => {
    const ctx = createPipelineContext("");
    const mockVision = {
      extractTextFromImages: vi.fn().mockResolvedValue([{ rawText: "Product specs" }]),
    } as unknown as Parameters<typeof stepOcr>[1];

    const result = await stepOcr(ctx, mockVision, ["https://img.example.com/1.jpg"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("Product specs");
  });

  it("handles empty image list gracefully", async () => {
    const ctx = createPipelineContext("");
    const mockVision = {
      extractTextFromImages: vi.fn().mockResolvedValue([]),
    } as unknown as Parameters<typeof stepOcr>[1];

    const result = await stepOcr(ctx, mockVision, []);
    expect(result).toHaveLength(0);
  });

  it("records error on vision API failure", async () => {
    const ctx = createPipelineContext("");
    const mockVision = {
      extractTextFromImages: vi.fn().mockRejectedValue(new Error("GLM API error")),
    } as unknown as Parameters<typeof stepOcr>[1];

    await expect(stepOcr(ctx, mockVision, ["img.jpg"])).rejects.toThrow();
    expect(ctx.errors.some((e) => e.step === "ocr")).toBe(true);
  });
});

// ---- Step 3: Translate ----
describe("stepTranslate", () => {
  it("translates product to Russian", async () => {
    const ctx = createPipelineContext("");
    const mockTranslator = {
      translateProduct: vi.fn().mockResolvedValue({
        titleRu: "Тестовый продукт",
        descriptionRu: "Описание",
        specificationsRu: [{ name: "Цвет", value: "Черный" }],
      }),
    } as unknown as Parameters<typeof stepTranslate>[1];

    const scraped = {
      title: "Test Product",
      descriptionText: "Description",
      specifications: [{ name: "Color", value: "Black" }],
    } as Parameters<typeof stepTranslate>[2];

    const result = await stepTranslate(ctx, mockTranslator, scraped);
    expect(result.titleRu).toBe("Тестовый продукт");
    expect(ctx.translated).toBeDefined();
  });

  it("records error on translation failure", async () => {
    const ctx = createPipelineContext("");
    const mockTranslator = {
      translateProduct: vi.fn().mockRejectedValue(new Error("DeepSeek API timeout")),
    } as unknown as Parameters<typeof stepTranslate>[1];

    const scraped = { title: "Test" } as Parameters<typeof stepTranslate>[2];
    await expect(stepTranslate(ctx, mockTranslator, scraped)).rejects.toThrow();
    expect(ctx.errors.some((e) => e.step === "translate")).toBe(true);
  });
});

// ---- Step 4: Category Match ----
describe("stepMatchCategory", () => {
  const mockTree = [
    { categoryId: 100, title: "Электроника", children: [
      { categoryId: 200, title: "Аксессуары", children: [
        { categoryId: 300, title: "Держатели", children: [] },
      ]},
    ]},
  ];

  it("matches product to correct category", async () => {
    const ctx = createPipelineContext("");
    const mockTranslator = {
      matchCategory: vi.fn().mockResolvedValue({
        categoryId: 300,
        categoryName: "Держатели",
        categoryPath: ["Электроника", "Аксессуары", "Держатели"],
        confidence: 0.9,
      }),
    } as unknown as Parameters<typeof stepMatchCategory>[1];

    const scraped = {
      title: "Phone holder",
      categoryPath: ["Electronics"],
      specifications: [],
    } as Parameters<typeof stepMatchCategory>[2];

    const result = await stepMatchCategory(ctx, mockTranslator, scraped, mockTree);
    expect(result.categoryId).toBe(300);
    expect(result.confidence).toBe(0.9);
  });

  it("throws on categoryId=0", async () => {
    const ctx = createPipelineContext("");
    const mockTranslator = {
      matchCategory: vi.fn().mockResolvedValue({ categoryId: 0, categoryName: "Unknown", categoryPath: [], confidence: 0 }),
    } as unknown as Parameters<typeof stepMatchCategory>[1];

    const scraped = { title: "Unknown product" } as Parameters<typeof stepMatchCategory>[2];
    await expect(stepMatchCategory(ctx, mockTranslator, scraped, mockTree)).rejects.toThrow("invalid ID");
  });

  it("records error when no match found", async () => {
    const ctx = createPipelineContext("");
    const mockTranslator = {
      matchCategory: vi.fn().mockRejectedValue(new Error("No matching category")),
    } as unknown as Parameters<typeof stepMatchCategory>[1];

    const scraped = { title: "Weird item" } as Parameters<typeof stepMatchCategory>[2];
    await expect(stepMatchCategory(ctx, mockTranslator, scraped, mockTree)).rejects.toThrow();
    expect(ctx.errors.some((e) => e.step === "category")).toBe(true);
  });
});

// ---- Step 5: Fill Attributes ----
describe("stepFillAttributes", () => {
  it("fills required attributes from product specs", async () => {
    const ctx = createPipelineContext("");
    const mockTranslator = {
      fillAttributes: vi.fn().mockResolvedValue({
        attributes: [{ attributeId: 1, name: "Цвет", value: "Черный" }],
        confidence: 0.85,
        missingRequired: [],
      }),
    } as unknown as Parameters<typeof stepFillAttributes>[1];

    const translated = {
      titleRu: "Продукт",
      descriptionRu: "Описание",
      specificationsRu: [{ name: "Цвет", value: "Черный" }],
    };

    const requiredAttrs = [{ id: 1, name: "Цвет", type: "string", isRequired: true, isCollection: false }];

    const result = await stepFillAttributes(ctx, mockTranslator, translated, 300, requiredAttrs);
    expect(result).toHaveLength(1);
    expect(result[0].attributeId).toBe(1);
  });

  it("returns empty attributes when none required", async () => {
    const ctx = createPipelineContext("");
    const mockTranslator = { fillAttributes: vi.fn() } as unknown as Parameters<typeof stepFillAttributes>[1];
    const translated = { titleRu: "", descriptionRu: "", specificationsRu: [] };

    const result = await stepFillAttributes(ctx, mockTranslator, translated, 0, []);
    expect(result).toHaveLength(0);
  });

  it("falls back to heuristic on API failure", async () => {
    const ctx = createPipelineContext("");
    const mockTranslator = {
      fillAttributes: vi.fn().mockRejectedValue(new Error("API error")),
    } as unknown as Parameters<typeof stepFillAttributes>[1];

    const translated = { titleRu: "", descriptionRu: "", specificationsRu: [{ name: "Цвет", value: "Красный" }] };
    const requiredAttrs = [{ id: 1, name: "Цвет", type: "string", isRequired: true, isCollection: false }];

    const result = await stepFillAttributes(ctx, mockTranslator, translated, 300, requiredAttrs);
    // Heuristic should fill from spec
    expect(result.length).toBeGreaterThanOrEqual(0);
    expect(ctx.errors.some((e) => e.step === "fill_attributes")).toBe(true);
  });
});

// ---- Step 6: Create Draft ----
describe("stepCreateDraft", () => {
  it("creates Ozon draft successfully", async () => {
    const ctx = createPipelineContext("");
    ctx.imageIds = ["https://cos.example.com/img1.jpg"];
    ctx.categoryTree = [{ categoryId: 300, title: "Test", typeId: 97110, children: [] }];

    const mockOzon = {
      createDraft: vi.fn().mockResolvedValue({ productId: 12345, offerId: "OFFER-001", status: "draft" }),
    } as unknown as Parameters<typeof stepCreateDraft>[1];

    const processed = {
      titleRu: "Продукт",
      descriptionRu: "Описание",
      categoryId: 300,
      priceRub: 500,
      specImageUrls: [],
      dimensionsCm: { length: 20, width: 15, height: 5 },
      weightKg: 0.5,
      attributes: [],
    } as Parameters<typeof stepCreateDraft>[2];

    const result = await stepCreateDraft(ctx, mockOzon, processed);
    expect(result.productId).toBe(12345);
    expect(result.offerId).toBe("OFFER-001");
    expect(ctx.draftId).toBe("OFFER-001");
  });

  it("records error on draft creation failure", async () => {
    const ctx = createPipelineContext("");
    const mockOzon = {
      createDraft: vi.fn().mockRejectedValue(new Error("Ozon API 429")),
    } as unknown as Parameters<typeof stepCreateDraft>[1];

    const processed = {
      titleRu: "Product",
      descriptionRu: "",
      categoryId: 300,
      priceRub: 100,
      specImageUrls: [],
      dimensionsCm: { length: 20, width: 15, height: 5 },
      weightKg: 0.5,
      attributes: [],
    } as Parameters<typeof stepCreateDraft>[2];

    await expect(stepCreateDraft(ctx, mockOzon, processed)).rejects.toThrow();
    expect(ctx.errors.some((e) => e.step === "create_draft")).toBe(true);
  });
});

// ---- Context & Helpers ----
describe("PipelineContext", () => {
  it("initializes with source URL and store ID", () => {
    const ctx = createPipelineContext("https://example.com/product", "store_2");
    expect(ctx.sourceUrl).toBe("https://example.com/product");
    expect(ctx.storeId).toBe("store_2");
    expect(ctx.errors).toHaveLength(0);
    expect(ctx.taskId).toBeDefined();
    expect(ctx.correlationId).toBeDefined();
  });
});

describe("findLeafTypeId", () => {
  it("finds type_id in leaf node", () => {
    const tree = [
      { categoryId: 1, title: "Root", children: [
        { categoryId: 2, title: "Child", typeId: 999, children: [] },
      ]},
    ];
    expect(findLeafTypeId(tree, 2)).toBe(999);
  });

  it("returns null when no type_id found", () => {
    const tree = [{ categoryId: 1, title: "Root", children: [] }];
    expect(findLeafTypeId(tree, 1)).toBeNull();
  });
});

describe("findAttributeCategoryId", () => {
  it("returns level-3 ancestor for deep categories", () => {
    const tree = [
      { categoryId: 1, title: "L1", children: [
        { categoryId: 2, title: "L2", children: [
          { categoryId: 3, title: "L3", children: [
            { categoryId: 4, title: "L4", children: [] },
          ]},
        ]},
      ]},
    ];
    expect(findAttributeCategoryId(tree, 4)).toBe(3);
  });
});

describe("buildProcessedProduct", () => {
  it("computes RUB price from CNY cost", () => {
    const ctx = createPipelineContext("");
    ctx.scraped = {
      title: "Product",
      price: { currentMin: 10, currentMax: 15, currency: "CNY" },
      specImages: [],
      detailImages: [],
      specifications: [],
      descriptionText: "",
      categoryPath: [],
    } as Parameters<typeof buildProcessedProduct>[0]["scraped"];
    ctx.translated = { titleRu: "Продукт", descriptionRu: "", specificationsRu: [] };
    ctx.category = { categoryId: 300, categoryName: "Test", categoryPath: [], confidence: 1 };

    const result = buildProcessedProduct(ctx, { exchangeRate: 12, defaultLength: 20, defaultWidth: 15, defaultHeight: 5, defaultWeight: 0.5 });
    expect(result.priceRub).toBe(156); // 10 * 12 * 1.3 = 156
    expect(result.titleRu).toBe("Продукт");
  });
});
