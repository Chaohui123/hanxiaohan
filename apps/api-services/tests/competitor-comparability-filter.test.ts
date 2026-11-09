import { describe, expect, it } from "vitest";
import { filterCurrentComparablePrices } from "../src/services/competitor-comparability.js";

const prices = [
  { competitorUrl: "https://ozon.ru/direct", price: 100 },
  { competitorUrl: "https://ozon.ru/downgraded", price: 90 },
  { competitorUrl: "", price: 80 },
];

describe("current comparability filtering", () => {
  it("only current direct links enter consumers; downgraded history is retained only for reconciliation", () => {
    const config = { links: [{ offerId: "A", competitorUrl: "https://ozon.ru/direct", comparability: "direct_comparable", includeInPriceComparison: true }] };
    expect(filterCurrentComparablePrices(prices, config, "A").map((item) => item.competitorUrl)).toEqual(["https://ozon.ru/direct"]);
    expect(filterCurrentComparablePrices(prices, null, "A")).toEqual([]);
  });

  it("other offers and explicit exclusions cannot leak into direct comparisons", () => {
    const config = { links: [
      { offerId: "B", competitorUrl: "https://ozon.ru/direct", comparability: "direct_comparable", includeInPriceComparison: true },
      { offerId: "A", competitorUrl: "https://ozon.ru/downgraded", comparability: "market_reference", includeInPriceComparison: true },
    ] };
    expect(filterCurrentComparablePrices(prices, config, "A")).toEqual([]);
  });
});
