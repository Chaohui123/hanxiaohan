import { describe, it, expect } from "vitest";
import { ProductValidator } from "../src/index.js";
import type { ProcessedProduct } from "@onzo/shared-types";

function makeProduct(overrides?: Partial<ProcessedProduct>): ProcessedProduct {
  return {
    sourceUrl: "https://detail.1688.com/offer/test.html",
    titleCn: "测试商品",
    priceCny: { min: 10, max: 20 },
    specImageUrls: ["https://img.example.com/1.jpg"],
    detailImageUrls: [],
    specificationsCn: [{ name: "材质", value: "不锈钢" }],
    ocrTexts: [],
    titleRu: "Тестовый товар премиум качества", // 20+ chars
    descriptionRu: "Описание тестового товара для Ozon",
    specificationsRu: [{ name: "Материал", value: "Нержавеющая сталь" }],
    categoryId: 17034370,
    categoryName: "Автоаксессуары",
    categoryPath: ["Авто", "Аксессуары"],
    attributes: [{ attributeId: 1, name: "Цвет", value: "Черный" }],
    priceRub: 1150,
    dimensionsCm: { length: 20, width: 15, height: 5 },
    weightKg: 0.5,
    imageIds: ["img-1"],
    ...overrides,
  };
}

describe("ProductValidator", () => {
  const validator = new ProductValidator();

  it("passes a valid product", () => {
    const result = validator.validate(makeProduct());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects missing title", () => {
    const result = validator.validate(makeProduct({ titleRu: "" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "titleRu")).toBe(true);
  });

  it("rejects short title (<10 chars)", () => {
    const result = validator.validate(makeProduct({ titleRu: "Коротко" }));
    expect(result.errors.some((e) => e.code === "TITLE_TOO_SHORT")).toBe(true);
  });

  it("rejects missing price", () => {
    const result = validator.validate(makeProduct({ priceRub: 0 }));
    expect(result.errors.some((e) => e.field === "priceRub")).toBe(true);
  });

  it("warns on extreme price", () => {
    const result = validator.validate(makeProduct({ priceRub: 2000000 }));
    expect(result.errors.some((e) => e.code === "PRICE_OUT_OF_RANGE")).toBe(true);
  });

  it("rejects missing images", () => {
    const result = validator.validate(makeProduct({ specImageUrls: [], imageIds: [] }));
    expect(result.errors.some((e) => e.code === "MISSING_IMAGES")).toBe(true);
  });

  it("rejects >15 images", () => {
    const urls = Array.from({ length: 16 }, (_, i) => `https://img.example.com/${i}.jpg`);
    const result = validator.validate(makeProduct({ imageIds: urls }));
    expect(result.errors.some((e) => e.code === "TOO_MANY_IMAGES")).toBe(true);
  });

  it("rejects zero dimensions (falsy check)", () => {
    const result = validator.validate(makeProduct({ dimensionsCm: { length: 0, width: 15, height: 5 } }));
    expect(result.errors.some((e) => e.code === "MISSING_DIMENSIONS")).toBe(true);
  });

  it("rejects dimension < 1cm", () => {
    const result = validator.validate(makeProduct({ dimensionsCm: { length: 0.5, width: 15, height: 5 } }));
    expect(result.errors.some((e) => e.code === "DIMENSION_TOO_SMALL")).toBe(true);
  });

  it("rejects missing weight", () => {
    const result = validator.validate(makeProduct({ weightKg: 0 }));
    expect(result.errors.some((e) => e.code === "MISSING_WEIGHT")).toBe(true);
  });

  it("rejects missing category", () => {
    const result = validator.validate(makeProduct({ categoryId: 0 }));
    expect(result.errors.some((e) => e.code === "MISSING_CATEGORY")).toBe(true);
  });
});
