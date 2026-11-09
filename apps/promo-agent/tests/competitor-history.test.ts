import { describe, expect, it } from "vitest";
import { hasFreshRegularPrice, hasVerifiedRegularPrice, latestByCompetitorUrl, selectPreviousCompetitorPrices, sharedPriceAverage } from "../src/competitor-history.js";

const point = (capturedAt: string, price = 900, competitorUrl = "https://www.ozon.ru/product/3250182880/") => ({
  capturedAt,
  price,
  competitorUrl,
});

describe("selectPreviousCompetitorPrices", () => {
  it("uses the prior daily batch instead of an arbitrary row offset", () => {
    const prices = [
      point("2026-10-26T03:17:01.000Z", 880),
      point("2026-10-26T03:17:00.000Z", 900, "https://www.ozon.ru/product/other/"),
      point("2026-10-25T03:17:00.000Z", 1000),
      point("2026-10-26T23:00:00.000Z", 500, ""),
    ];
    const selected = selectPreviousCompetitorPrices(prices, "2026-10-27T03:18:00.000Z");
    expect(selected.map((item) => item.price)).toEqual([880, 900]);
  });

  it("does not compare a first collection with same-day or invalid data", () => {
    expect(selectPreviousCompetitorPrices([point("2026-10-27T00:00:00.000Z")], "2026-10-27T03:18:00.000Z")).toEqual([]);
    expect(selectPreviousCompetitorPrices([point("invalid")], "2026-10-27T03:18:00.000Z")).toEqual([]);
    expect(selectPreviousCompetitorPrices([point("2026-10-26T03:17:00.000Z")], "invalid")).toEqual([]);
  });
});

describe("hasVerifiedRegularPrice", () => {
  it("only accepts a regular price that matches the API comparison field", () => {
    expect(hasVerifiedRegularPrice({ ...point("2026-11-03T00:00:00Z", 1661), priceRegular: 1661, priceType: "regular" })).toBe(true);
    expect(hasVerifiedRegularPrice({ ...point("2026-11-03T00:00:00Z", 1495), priceRegular: null, priceType: "legacy_unknown" })).toBe(false);
    expect(hasVerifiedRegularPrice({ ...point("2026-11-03T00:00:00Z", 1495), priceRegular: null, priceType: "regular" })).toBe(false);
    expect(hasVerifiedRegularPrice({ ...point("2026-11-03T00:00:00Z", 1495), priceRegular: 1661, priceType: "regular" })).toBe(false);
  });
});

describe("sharedPriceAverage", () => {
  it("compares only URLs present in both batches and rejects disjoint samples", () => {
    const current = new Map([["https://ozon.ru/a", 90], ["https://ozon.ru/b", 100]]);
    const previous = [point("2026-11-02T00:00:00Z", 120, "https://ozon.ru/a"), point("2026-11-02T00:00:00Z", 300, "https://ozon.ru/old")];
    expect(sharedPriceAverage(current, previous)).toEqual({ current: 90, previous: 120 });
    expect(sharedPriceAverage(new Map([["https://ozon.ru/new", 50]]), previous)).toBeNull();
  });
});

describe("latestByCompetitorUrl", () => {
  it("selects the newest snapshot per URL instead of input order", () => {
    const rows = [point("2026-11-03T02:00:00Z", 90, "https://ozon.ru/a"), point("2026-11-03T01:00:00Z", 100, "https://ozon.ru/a")];
    expect(latestByCompetitorUrl(rows).map((item) => item.price)).toEqual([90]);
  });
});

describe("hasFreshRegularPrice", () => {
  it("rejects future, stale, invalid-time and legacy records", () => {
    const now = Date.parse("2026-11-03T12:00:00Z");
    expect(hasFreshRegularPrice({ ...point("2026-11-03T11:00:00Z", 100), priceRegular: 100, priceType: "regular" }, now)).toBe(true);
    expect(hasFreshRegularPrice({ ...point("2026-11-03T13:00:00Z", 100), priceRegular: 100, priceType: "regular" }, now)).toBe(false);
    expect(hasFreshRegularPrice({ ...point("2026-11-02T11:00:00Z", 100), priceRegular: 100, priceType: "regular" }, now)).toBe(false);
    expect(hasFreshRegularPrice({ ...point("invalid", 100), priceRegular: 100, priceType: "regular" }, now)).toBe(false);
    expect(hasFreshRegularPrice({ ...point("2026-11-03T11:00:00Z", 100), priceRegular: null, priceType: "legacy_unknown" }, now)).toBe(false);
  });
});
