import { describe, it, expect } from "vitest";
import { PricingEngine } from "../../src/services/pricing-engine.js";

describe("PricingEngine", () => {
  const engine = new PricingEngine();

  it("calculates price with competitors", () => {
    const result = engine.calculatePrice(10, 12, [
      { productId: 1, priceRub: 500, rating: 4, reviewCount: 10, salesVolume: 100, title: "C1" },
    ]);
    expect(result.basePriceRub).toBeGreaterThan(0);
    expect(result.finalPriceRub).toBeGreaterThan(0);
    expect(result.isFeasible).toBeDefined();
  });

  it("handles zero competitors", () => {
    const result = engine.calculatePrice(10, 12, []);
    expect(result.finalPriceRub).toBeGreaterThan(0);
  });

  it("applies desired position leader", () => {
    const r1 = engine.calculatePrice(10, 12, [{ productId: 1, priceRub: 200, rating: 4, reviewCount: 10, salesVolume: 100, title: "C" }], { desiredPosition: "leader" });
    expect(r1.pricePosition).toBeDefined();
  });

  it("applies premium position", () => {
    const r = engine.calculatePrice(50, 12, [{ productId: 1, priceRub: 5000, rating: 5, reviewCount: 100, salesVolume: 500, title: "P" }], { desiredPosition: "premium" });
    expect(r.finalPriceRub).toBeGreaterThan(0);
  });

  it("handles high exchange rate", () => {
    const r = engine.calculatePrice(10, 15, []);
    expect(r.finalPriceRub).toBeGreaterThan(150); // 10 * 15 = 150 base
  });
});
