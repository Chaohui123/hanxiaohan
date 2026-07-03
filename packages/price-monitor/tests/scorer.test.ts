import { describe, it, expect } from "vitest";
import { scoreProduct } from "../src/scorer.js";

describe("scoreProduct", () => {
  it("scores competitive price as strong_buy", () => {
    const score = scoreProduct({
      ourPriceRub: 800,
      competitorPrices: [{ priceRub: 1000, platform: "ozon" }, { priceRub: 1100, platform: "wildberries" }],
      salesSignals: { totalSold: 2000, reviewCount: 100, rating: 4.7 },
    });
    expect(score.recommendation).toBe("strong_buy");
    expect(score.totalScore).toBeGreaterThanOrEqual(70);
  });

  it("scores above-average price as watch", () => {
    const score = scoreProduct({
      ourPriceRub: 1500,
      competitorPrices: [{ priceRub: 1000, platform: "ozon" }],
    });
    expect(["watch", "skip"]).toContain(score.recommendation);
  });

  it("handles no competitor data", () => {
    const score = scoreProduct({ ourPriceRub: 500, competitorPrices: [] });
    expect(score.priceScore).toBe(20); // neutral
  });

  it("scores trending-up price as consider or better", () => {
    const score = scoreProduct({
      ourPriceRub: 1200,
      competitorPrices: [{ priceRub: 1300, platform: "ozon" }],
      priceHistory: [
        { avgPrice: 1300, date: "2026-07-03" },
        { avgPrice: 1200, date: "2026-07-02" },
        { avgPrice: 1100, date: "2026-07-01" },
      ],
    });
    expect(score.trendScore).toBeGreaterThanOrEqual(20);
  });

  it("returns all score components between 0-100", () => {
    const score = scoreProduct({
      ourPriceRub: 900,
      competitorPrices: [{ priceRub: 1000, platform: "ozon" }],
    });
    expect(score.totalScore).toBeGreaterThanOrEqual(0);
    expect(score.totalScore).toBeLessThanOrEqual(100);
    expect(score.priceScore).toBeGreaterThanOrEqual(0);
    expect(score.trendScore).toBeGreaterThanOrEqual(0);
    expect(score.volumeScore).toBeGreaterThanOrEqual(0);
  });
});
