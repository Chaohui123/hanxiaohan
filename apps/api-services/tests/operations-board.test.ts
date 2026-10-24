import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const state = vi.hoisted(() => ({
  ozonRequest: vi.fn(),
  dbAll: vi.fn(),
}));

vi.mock("../src/db/models.js", () => ({
  getActiveStoreConfigs: async () => [
    { storeId: "store_1", storeName: "Test Store", clientId: "cid", apiKey: "plain-key", active: 1 },
  ],
}));

vi.mock("../src/db/connection.js", () => ({
  getDb: async () => ({ all: state.dbAll }),
}));

vi.mock("../src/services/crypto.js", () => ({
  isEncrypted: () => false,
  decrypt: (value: string) => value,
}));

vi.mock("../src/services/exchange-rate.js", () => ({
  getExchangeRate: async () => ({ rate: 10, reliable: true }),
}));

vi.mock("@onzo/ozon-api-wrapper", () => ({
  AuthManager: class {
    constructor(_config: unknown) { /* no-op */ }
  },
  OzonClient: class {
    constructor(_config: unknown) { /* no-op */ }
    request(...args: unknown[]) {
      return state.ozonRequest(...args);
    }
  },
}));

const catalog = [
  ["MAR-YAM-66T-01", 5486165368],
  ["MAR-YAM-6E5-01", 5489986970],
  ["GEN-CARB-168F-01", 5393398726],
  ["MAR-YAM-61N-01", 5328928186],
  ["MAR-COVER-S", 5768382343],
  ["MAR-COVER-M", 5768382441],
  ["MAR-YAM-6E7-01", 5302493207],
  ["CN-HAV-H6-DOOR-01", 5302498432],
  ["MAR-ICE-BLADE-01", 5522803772],
  ["MAR-BAITBOAT-01", 5522804641],
  ["MAR-ICE-BLADE-150-01", 5573175131],
  ["MOT-CARB-PZ30-01", 6394766996],
  ["GEN-CARB-188F-02", 6454457600],
  ["GEN-BELT-33X14-01", 6458804241],
  ["GEN-BELT-35X1126-01", 5900647591],
  ["MAR-YAM-61N-CABLE-01", 5902773711],
  ["CN-AUTO-GRILLE-COVER-01", 5903494562],
  ["MOT-MIK-VM34-KIT-01", 5931782921],
] as const;

const products = catalog.map(([offerId, sku], index) => ({
  offerId,
  sku,
  productId: 7000000000 + index,
  name: `Real sample ${offerId}`,
}));

const funnels = products.map((_, index) => ({
  views: index === 0 ? 120 : index === 1 ? 75 : index === 2 ? 49 : 60 + index,
  carts: index === 0 ? 12 : index === 1 ? 0 : index + 1,
  orderedUnits: index === 0 ? 6 : index,
  cancellations: index === 0 ? 2 : 0,
  deliveredUnits: index === 0 ? 4 : Math.max(0, index - 1),
  orderedRevenueRub: index === 0 ? 6543.21 : index * 100.5,
}));

function analyticsRows() {
  return products.map((product, index) => ({
    dimensions: [{ id: String(product.sku), name: product.offerId }],
    metrics: [
      funnels[index].views,
      funnels[index].carts,
      funnels[index].orderedUnits,
      funnels[index].cancellations,
      funnels[index].deliveredUnits,
      funnels[index].orderedRevenueRub,
    ],
  })).reverse();
}

function defaultOzonRequest(_method: unknown, path: unknown, _body: unknown): Promise<unknown> {
  if (path === "/v3/product/list") {
    return Promise.resolve({ result: { items: products.map((product) => ({ product_id: product.productId })) } });
  }
  if (path === "/v3/product/info/list") {
    return Promise.resolve({
      items: products.map((product) => ({
        id: product.productId,
        sku: product.sku,
        offer_id: product.offerId,
        name: product.name,
        statuses: { status_name: "Продается" },
      })),
    });
  }
  if (path === "/v1/analytics/data") {
    return Promise.resolve({ result: { data: analyticsRows() } });
  }
  if (path === "/v5/product/info/prices") {
    return Promise.resolve({
      items: products.map((product, index) => ({
        offer_id: product.offerId,
        price: { price: String(100 + index), min_price: String(90 + index) },
      })),
    });
  }
  if (path === "/v2/actions/products") {
    return Promise.resolve({ products: [{ id: products[0].productId, action_price: { amount: "80" } }] });
  }
  if (path === "/v4/product/info/stocks") {
    return Promise.resolve({
      items: products.map((product, index) => ({
        offer_id: product.offerId,
        stocks: index === 0
          ? [{ type: "rfbs", present: 7 }, { type: "fbo", present: 5 }]
          : [{ type: "rfbs", present: index }],
      })),
    });
  }
  return Promise.reject(new Error(`Unexpected Ozon request: ${String(path)}`));
}

let app: Express;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-30T12:00:00.000Z"));
  state.ozonRequest.mockReset();
  state.ozonRequest.mockImplementation(defaultOzonRequest);
  state.dbAll.mockReset();
  state.dbAll.mockResolvedValue([{ ozon_offer_id: products[0].offerId, purchase_price_cny: 10.5 }]);

  const { createPromoDataRouter } = await import("../src/routes/promo-data.router.js");
  app = express();
  app.use(express.json());
  app.use("/api", createPromoDataRouter());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/promo/operations-board", () => {
  it("maps 18 real-shaped SKU rows, request-ordered metrics, totals, prices, stocks and costs", async () => {
    const res = await request(app).get("/api/promo/operations-board");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      period: { days: 30, dateFrom: "2026-10-01", dateTo: "2026-10-30" },
      sourceStatus: { analytics: "ok", products: "ok", price: "ok", stock: "ok", cost: "ok" },
    });
    expect(res.body.items).toHaveLength(18);
    expect(new Set(res.body.items.map((item: { sku: number }) => item.sku))).toEqual(new Set(products.map((product) => product.sku)));

    const first = res.body.items.find((item: { offerId: string }) => item.offerId === products[0].offerId);
    expect(first).toMatchObject({
      offerId: products[0].offerId,
      sku: products[0].sku,
      name: products[0].name,
      views: 120,
      carts: 12,
      orderedUnits: 6,
      cancellations: 2,
      deliveredUnits: 4,
      orderedRevenueRub: 6543.21,
      cartRatePct: 10,
      orderRatePct: 5,
      currentPriceRub: 800,
      minPriceRub: 900,
      stock: 12,
      costCny: 10.5,
      group: "WATCH",
    });
    expect(first.warnings.join(" ")).toContain("ORDERED_REVENUE_NOT_ACTUAL_RECEIPTS");
    expect(first).not.toHaveProperty("estimatedNetProfit");
    expect(first).not.toHaveProperty("netProfitRub");

    const second = res.body.items.find((item: { offerId: string }) => item.offerId === products[1].offerId);
    expect(second).toMatchObject({ views: 75, carts: 0, currentPriceRub: 1010, minPriceRub: 910, stock: 1, group: "CARD_REPAIR" });

    const expectedTotals = funnels.reduce((totals, funnel) => ({
      views: totals.views + funnel.views,
      carts: totals.carts + funnel.carts,
      orderedUnits: totals.orderedUnits + funnel.orderedUnits,
      cancellations: totals.cancellations + funnel.cancellations,
      deliveredUnits: totals.deliveredUnits + funnel.deliveredUnits,
      orderedRevenueRub: totals.orderedRevenueRub + funnel.orderedRevenueRub,
    }), { views: 0, carts: 0, orderedUnits: 0, cancellations: 0, deliveredUnits: 0, orderedRevenueRub: 0 });
    expect(res.body.totals).toMatchObject({
      ...expectedTotals,
      orderedRevenueRub: Math.round(expectedTotals.orderedRevenueRub * 100) / 100,
      cartRatePct: Math.round(expectedTotals.carts / expectedTotals.views * 10000) / 100,
      orderRatePct: Math.round(expectedTotals.orderedUnits / expectedTotals.views * 10000) / 100,
      stock: 165,
    });

    const analyticsCall = state.ozonRequest.mock.calls.find((call) => call[1] === "/v1/analytics/data");
    expect(analyticsCall?.[0]).toBe("POST");
    expect(analyticsCall?.[2]).toMatchObject({
      date_from: "2026-10-01",
      date_to: "2026-10-30",
      dimension: ["sku"],
      metrics: ["hits_view", "hits_tocart", "ordered_units", "cancellations", "delivered_units", "revenue"],
    });
    expect(state.ozonRequest.mock.calls.every((call) => call[0] === "POST")).toBe(true);
  });

  it("returns true zeros for a catalog SKU absent from Analytics", async () => {
    state.ozonRequest.mockImplementation((_method: unknown, path: unknown, body: unknown) => {
      if (path === "/v1/analytics/data") {
        const rows = analyticsRows().filter((row) => row.dimensions[0].id !== String(products[0].sku));
        return Promise.resolve({ result: { data: rows } });
      }
      return defaultOzonRequest(_method, path, body);
    });

    const res = await request(app).get("/api/promo/operations-board?days=7");

    expect(res.status).toBe(200);
    const missing = res.body.items.find((item: { sku: number }) => item.sku === products[0].sku);
    expect(missing).toMatchObject({
      views: 0,
      carts: 0,
      orderedUnits: 0,
      cancellations: 0,
      deliveredUnits: 0,
      orderedRevenueRub: 0,
      cartRatePct: 0,
      orderRatePct: 0,
    });
  });

  it("fails with 502 and null totals instead of fabricated zeros when Analytics fails", async () => {
    state.ozonRequest.mockImplementation((_method: unknown, path: unknown, body: unknown) => {
      if (path === "/v1/analytics/data") return Promise.reject(new Error("analytics unavailable"));
      return defaultOzonRequest(_method, path, body);
    });

    const res = await request(app).get("/api/promo/operations-board?days=30");

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      success: false,
      totals: null,
      items: [],
      sourceStatus: { analytics: "error", products: "ok", price: "not_loaded", stock: "not_loaded" },
    });
    expect(res.body.error).toContain("analytics unavailable");
    expect(res.body.totals).not.toEqual(expect.objectContaining({ views: 0 }));
  });

  it("keeps Analytics data and exposes null prices with warnings on a partial price failure", async () => {
    state.ozonRequest.mockImplementation((_method: unknown, path: unknown, body: unknown) => {
      if (path === "/v5/product/info/prices") return Promise.reject(new Error("prices unavailable"));
      return defaultOzonRequest(_method, path, body);
    });

    const res = await request(app).get("/api/promo/operations-board?days=1");

    expect(res.status).toBe(200);
    expect(res.body.sourceStatus.price).toBe("error");
    expect(res.body.sourceStatus.analytics).toBe("ok");
    expect(res.body.items[0]).toMatchObject({ currentPriceRub: null, minPriceRub: null });
    expect(res.body.items.every((item: { warnings: string[] }) => item.warnings.some((warning) => warning.startsWith("PRICE_UNAVAILABLE")))).toBe(true);
    expect(res.body.items.reduce((sum: number, item: { views: number }) => sum + item.views, 0)).toBe(res.body.totals.views);
    expect(state.ozonRequest.mock.calls.some((call) => call[1] === "/v2/actions/products")).toBe(false);
  });

  it("keeps prices and exposes null item/total stock with warnings on a partial stock failure", async () => {
    state.ozonRequest.mockImplementation((_method: unknown, path: unknown, body: unknown) => {
      if (path === "/v4/product/info/stocks") return Promise.reject(new Error("stocks unavailable"));
      return defaultOzonRequest(_method, path, body);
    });

    const res = await request(app).get("/api/promo/operations-board");

    expect(res.status).toBe(200);
    expect(res.body.sourceStatus.stock).toBe("error");
    expect(res.body.totals.stock).toBeNull();
    expect(res.body.items.every((item: { stock: null }) => item.stock === null)).toBe(true);
    expect(res.body.items.every((item: { warnings: string[] }) => item.warnings.some((warning) => warning.startsWith("STOCK_UNAVAILABLE")))).toBe(true);
    expect(res.body.items.find((item: { offerId: string }) => item.offerId === products[0].offerId).currentPriceRub).toBe(800);
  });

  it.each([
    [1, "2026-10-30"],
    [7, "2026-10-24"],
    [30, "2026-10-01"],
  ])("accepts days=%i and uses an inclusive UTC period", async (days, dateFrom) => {
    const res = await request(app).get(`/api/promo/operations-board?days=${days}`);

    expect(res.status).toBe(200);
    expect(res.body.period).toEqual({ days, dateFrom, dateTo: "2026-10-30" });
  });

  it.each(["0", "2", "8", "31", "abc", "1.0", "07", ""])("rejects invalid days=%s before any Ozon call", async (days) => {
    const res = await request(app).get(`/api/promo/operations-board?days=${days}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, error: "days must be one of 1, 7, 30" });
    expect(state.ozonRequest).not.toHaveBeenCalled();
    expect(state.dbAll).not.toHaveBeenCalled();
  });
});

describe("operations board grouping", () => {
  it("applies exclusions and thresholds in explicit priority order", async () => {
    const { classifyOperationsGroup, OPERATIONS_GROUP_PRIORITY } = await import("../src/services/operations-board.js");

    expect(OPERATIONS_GROUP_PRIORITY).toEqual(["ORDER_VALIDATION", "WINTER_PRIORITY", "CARD_REPAIR", "COLD_START", "WATCH"]);
    expect(classifyOperationsGroup("MAR-YAM-61N-01", 100, 0)).toBe("ORDER_VALIDATION");
    expect(classifyOperationsGroup("MAR-YAM-61N-CABLE-01", 10, 0)).toBe("ORDER_VALIDATION");
    expect(classifyOperationsGroup("MAR-PUMP-61N-01", 100, 0)).toBe("CARD_REPAIR");
    expect(classifyOperationsGroup("MAR-PUMP-61N-01", 100, 1)).toBe("WATCH");
    expect(classifyOperationsGroup("CN-AUTO-GRILLE-COVER-01", 100, 0)).toBe("WINTER_PRIORITY");
    expect(classifyOperationsGroup("MOT-MIK-VM34-KIT-01", 10, 0)).toBe("WINTER_PRIORITY");
    expect(classifyOperationsGroup("GEN-BELT-35X1126-01", 10, 0)).toBe("WINTER_PRIORITY");
    expect(classifyOperationsGroup("OTHER", 50, 0)).toBe("CARD_REPAIR");
    expect(classifyOperationsGroup("OTHER", 49, 0)).toBe("COLD_START");
    expect(classifyOperationsGroup("OTHER", 49, 1)).toBe("COLD_START");
    expect(classifyOperationsGroup("OTHER", 50, 1)).toBe("WATCH");
  });

  it("sorts route items by the same group priority", async () => {
    const res = await request(app).get("/api/promo/operations-board");
    const ranks = { ORDER_VALIDATION: 0, WINTER_PRIORITY: 1, CARD_REPAIR: 2, COLD_START: 3, WATCH: 4 };
    const actual = res.body.items.map((item: { group: keyof typeof ranks }) => ranks[item.group]);

    expect(res.status).toBe(200);
    expect(actual).toEqual([...actual].sort((a, b) => a - b));
    expect(res.body.items[0].group).toBe("ORDER_VALIDATION");
  });
});
