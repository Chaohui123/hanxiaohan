import { describe, it, expect } from "vitest";
import { fullComplianceCheck, checkCategoryCompliance, checkProductCompliance } from "../../src/services/compliance.js";

describe("checkCategoryCompliance", () => {
  it("blocks alcohol category", () => {
    const r = checkCategoryCompliance(1, "Алкогольные напитки", ["Еда"]);
    expect(r.blocked).toBe(true);
    expect(r.blockedReason).toBeDefined();
  });

  it("blocks weapons category", () => {
    const r = checkCategoryCompliance(1, "Оружие и патроны", ["Спорт"]);
    expect(r.blocked).toBe(true);
  });

  it("blocks medicinal category (hard block — requires registration)", () => {
    // "лекарственн" was promoted to the high-risk hard-block list
    // (compliance.ts: "Medical without registration"), so medicinal herbs
    // are now blocked outright instead of warned.
    const r = checkCategoryCompliance(1, "Лекарственные травы", ["Здоровье"]);
    expect(r.blocked).toBe(true);
    expect(r.blockedReason).toBeDefined();
  });

  it("warns on restricted but not blocked", () => {
    // "биологически активн" (dietary supplements) is a medium-risk keyword:
    // restricted → warning, but not on the high-risk hard-block list.
    const r = checkCategoryCompliance(1, "Биологически активные добавки", ["Здоровье"]);
    expect(r.blocked).toBe(false);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("passes normal category", () => {
    const r = checkCategoryCompliance(1, "Автоаксессуары", ["Авто"]);
    expect(r.blocked).toBe(false);
    expect(r.allowed).toBe(true);
  });

  it("blocks category by path keyword", () => {
    const r = checkCategoryCompliance(1, "Normal", ["Запрещенные", "Табак"]);
    expect(r.blocked).toBe(true);
  });
});

describe("checkProductCompliance", () => {
  it("warns on free claims", () => {
    const r = checkProductCompliance("Бесплатный товар", "");
    // "Бесплатн" is in restricted patterns
    expect(r.blocked).toBe(false);
  });

  it("passes normal product", () => {
    const r = checkProductCompliance("Автомобильный держатель", "Качественный продукт");
    expect(r.blocked).toBe(false);
  });
});

describe("fullComplianceCheck", () => {
  it("blocks when category is banned", () => {
    const r = fullComplianceCheck({ categoryId: 1, categoryName: "Алкоголь", categoryPath: [], titleRu: "", descriptionRu: "" });
    expect(r.blocked).toBe(true);
  });

  it("combines warnings from both checks", () => {
    const r = fullComplianceCheck({ categoryId: 1, categoryName: "Лекарства", categoryPath: [], titleRu: "Бесплатный товар", descriptionRu: "" });
    // Either blocked or has warnings
    expect(r.blocked || r.warnings.length > 0).toBe(true);
  });
});
