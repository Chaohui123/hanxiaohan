// Route tests for inventory.route.ts Ozon fallback — product_performance 为空时
// 从 Ozon Seller API 实时合成 promo-agent 商品数据（supertest + 真实内存 SQLite + mock Ozon client）
import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { createSqliteTestDb } from "./helpers/test-db.js";

// ---- Hoisted mock state (shared with vi.mock factories) ----
const state = vi.hoisted(() => ({
  ozonRequest: vi.fn(),
  ozonShouldFail: false,
}));

vi.mock("../src/db/connection.js", () => ({
  // Deferred access: `sqlite` below is initialized before any test runs.
  getDb: async () => sqlite.adapter,
  serializedWrite: async (fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../src/db/models.js", () => ({
  getActiveStoreConfigs: async () => [
    { storeId: "store_1", storeName: "Test Store", clientId: "cid", apiKey: "plain-key", active: 1 },
  ],
}));

vi.mock("../src/services/crypto.js", () => ({
  isEncrypted: () => false,
  decrypt: (s: string) => s,
}));

// 汇率固定 10 CNY→RUB，避免测试触达真实汇率服务（外网）
vi.mock("../src/services/exchange-rate.js", () => ({
  getExchangeRate: async () => ({ rate: 10 }),
}));

vi.mock("@onzo/ozon-api-wrapper", () => ({
  AuthManager: class {
    constructor(_config: unknown) { /* no-op */ }
  },
  OzonClient: class {
    constructor(_config: unknown) { /* no-op */ }
    request(...args: unknown[]) {
      if (state.ozonShouldFail) return Promise.reject(new Error("ozon api down"));
      return state.ozonRequest(...args);
    }
  },
}));

// ---- Real in-memory SQLite DB — schema mirrors data/onzo.db ----
const sqlite = createSqliteTestDb();

sqlite.db.exec(`
  CREATE TABLE product_performance (
    product_id TEXT,
    title TEXT,
    sales INTEGER DEFAULT 0,
    revenue_rub REAL DEFAULT 0,
    stock INTEGER DEFAULT 0,
    rating REAL DEFAULT 0,
    margin REAL DEFAULT 0,
    review_count INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE sku_1688_mapping (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL DEFAULT 'store_1',
    ozon_offer_id TEXT NOT NULL,
    ozon_sku INTEGER,
    source_1688_url TEXT DEFAULT '',
    purchase_price_cny REAL DEFAULT 0
  );
  CREATE TABLE promo_pricing_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    offer_id TEXT,
    name TEXT,
    old_price REAL,
    new_price REAL,
    reason TEXT,
    applied_at TEXT DEFAULT (datetime('now'))
  );
`);

/** 默认 Ozon API 应答：3 个商品，其中 OFFER-3 无库存应被过滤 */
function defaultOzonRequest(_method: unknown, path: unknown, _body: unknown) {
  if (path === "/v3/product/list") {
    return Promise.resolve({ result: { items: [{ product_id: 1 }, { product_id: 2 }, { product_id: 3 }] } });
  }
  if (path === "/v3/product/info/list") {
    return Promise.resolve({
      items: [
        { id: 1, offer_id: "OFFER-1", name: "Dog Boots" },
        { id: 2, offer_id: "OFFER-2", name: "Boat Cover" },
        { id: 3, offer_id: "OFFER-3", name: "No Stock Item" },
      ],
    });
  }
  if (path === "/v5/product/info/prices") {
    return Promise.resolve({
      items: [
        { offer_id: "OFFER-1", price: { price: "1500.00" } },
        { offer_id: "OFFER-2", price: { price: "3200.50" } },
        { offer_id: "OFFER-3", price: { price: "999.00" } },
      ],
    });
  }
  if (path === "/v4/product/info/stocks") {
    return Promise.resolve({
      items: [
        { offer_id: "OFFER-1", product_id: 101, stocks: [{ type: "rfbs", present: 8 }, { type: "rfbs", present: 2 }] },
        { offer_id: "OFFER-2", product_id: 102, stocks: [{ type: "rfbs", present: 5 }] },
        { offer_id: "OFFER-3", product_id: 103, stocks: [{ type: "rfbs", present: 0 }] },
      ],
    });
  }
  if (path === "/v4/product/info/attributes") {
    return Promise.resolve({
      result: [{ offer_id: "OFFER-1", weight: 150, depth: 300, width: 150, height: 50 }],
    });
  }
  if (path === "/v1/product/import/prices") {
    return Promise.resolve({ result: [{ offer_id: "OFFER-1", updated: true, errors: [] }] });
  }
  if (path === "/v2/products/stocks") {
    return Promise.resolve({ result: [{ offer_id: "OFFER-1", updated: true, errors: [] }] });
  }
  return Promise.resolve({});
}

let app: Express;

beforeEach(async () => {
  // 路由模块持有 Ozon fallback 缓存 — 每个测试重建模块拿到干净缓存
  vi.resetModules();
  state.ozonShouldFail = false;
  state.ozonRequest.mockClear();
  state.ozonRequest.mockImplementation(defaultOzonRequest);

  sqlite.db.exec("DELETE FROM product_performance; DELETE FROM sku_1688_mapping; DELETE FROM promo_pricing_history;");
  sqlite.db.prepare(
    "INSERT INTO sku_1688_mapping (id, ozon_offer_id, ozon_sku, purchase_price_cny) VALUES (?, ?, ?, ?)",
  ).run("map-1", "OFFER-1", 101, 50.5);

  const { createInventoryRouter } = await import("../src/routes/inventory.route.js");
  app = express();
  app.use(express.json());
  app.use("/api/inventory", createInventoryRouter());
});

describe("GET /api/inventory — Ozon fallback", () => {
  it("product_performance 为空时回退到 Ozon 在售商品", async () => {
    const res = await request(app).get("/api/inventory?limit=100");

    expect(res.status).toBe(200);
    // OFFER-3 库存为 0 被过滤
    expect(res.body.items).toHaveLength(2);

    const item1 = res.body.items.find((i: Record<string, unknown>) => i.offerId === "OFFER-1");
    expect(item1).toMatchObject({
      offerId: "OFFER-1",
      name: "Dog Boots",
      price: 15000, // 1500 CNY × 10（v5 prices 返回 CNY，契约输出 RUB）
      stock: 10, // 8 + 2 汇总
      cost: 50.5, // sku_1688_mapping 匹配
      rating: 0,
      orders: 0,
      revenue: 0,
      quantity: 10,
    });

    const item2 = res.body.items.find((i: Record<string, unknown>) => i.offerId === "OFFER-2");
    expect(item2).toMatchObject({ offerId: "OFFER-2", price: 32005, stock: 5, cost: 0 }); // 3200.5 × 10；无映射 → cost 0
  });

  it("product_performance 有数据时走旧逻辑，不调用 Ozon API", async () => {
    sqlite.db.prepare(
      "INSERT INTO product_performance (product_id, title, sales, revenue_rub, stock) VALUES (?, ?, ?, ?, ?)",
    ).run("LOCAL-1", "Local Product", 7, 2000, 3);

    const res = await request(app).get("/api/inventory?limit=100");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ offerId: "LOCAL-1", name: "Local Product", orders: 7 });
    expect(state.ozonRequest).not.toHaveBeenCalled();
  });

  it("第二次请求命中内存缓存，不重复调用 Ozon API", async () => {
    const first = await request(app).get("/api/inventory?limit=100");
    const second = await request(app).get("/api/inventory?limit=100");

    expect(first.status).toBe(200);
    expect(second.body.items).toEqual(first.body.items);
    // 4 个端点各调用一次
    expect(state.ozonRequest).toHaveBeenCalledTimes(4);
  });

  it("Ozon API 失败时返回空 items 而不是 500", async () => {
    state.ozonShouldFail = true;
    const res = await request(app).get("/api/inventory?limit=100");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });
});

describe("GET /api/inventory/:offerId — Ozon fallback", () => {
  it("本地无记录时从 Ozon 商品中查找单个商品", async () => {
    const res = await request(app).get("/api/inventory/OFFER-1");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      offerId: "OFFER-1",
      name: "Dog Boots",
      price: 15000,
      stock: 10,
      cost: 50.5,
      reviewCount: 0,
    });
  });

  it("Ozon 侧也找不到时返回 404", async () => {
    const res = await request(app).get("/api/inventory/NOPE");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "Product not found", offerId: "NOPE" });
  });

  it("本地有记录时不走 Ozon fallback", async () => {
    sqlite.db.prepare(
      "INSERT INTO product_performance (product_id, title, sales, revenue_rub, stock) VALUES (?, ?, ?, ?, ?)",
    ).run("OFFER-1", "Local Version", 3, 1800, 9);

    const res = await request(app).get("/api/inventory/OFFER-1");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ offerId: "OFFER-1", name: "Local Version" });
    expect(state.ozonRequest).not.toHaveBeenCalled();
  });
});

describe("PUT /api/inventory/:offerId/price — 真实推 Ozon 改价", () => {
  it("推送成功：RUB→CNY 换算后调 /v1/product/import/prices，落库+审计", async () => {
    state.ozonRequest.mockImplementation((_m: unknown, path: unknown, _b: unknown) => {
      if (path === "/v1/product/import/prices") {
        return Promise.resolve({ result: [{ offer_id: "OFFER-1", updated: true, errors: [] }] });
      }
      return defaultOzonRequest(_m, path, _b);
    });

    const res = await request(app).put("/api/inventory/OFFER-1/price").send({ price: 1500 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, offerId: "OFFER-1", newPrice: 1500, priceCny: "150.00" });

    // 验证 Ozon 推送载荷：CNY 价 = RUB / 汇率(10)
    const pushCall = state.ozonRequest.mock.calls.find((c) => c[1] === "/v1/product/import/prices");
    expect(pushCall?.[2]).toEqual({ prices: [{ offer_id: "OFFER-1", price: "150.00", currency_code: "CNY" }] });

    // 审计记录已写
    const audit = sqlite.db.prepare("SELECT * FROM promo_pricing_history WHERE offer_id = ?").get("OFFER-1") as Record<string, unknown>;
    expect(audit).toMatchObject({ offer_id: "OFFER-1", new_price: 1500, reason: "promo-agent auto" });
  });

  it("Ozon 返回 updated:false + errors 时返回 502，不落审计", async () => {
    state.ozonRequest.mockImplementation((_m: unknown, path: unknown, _b: unknown) => {
      if (path === "/v1/product/import/prices") {
        return Promise.resolve({ result: [{ offer_id: "OFFER-1", updated: false, errors: [{ description: "price too low" }] }] });
      }
      return defaultOzonRequest(_m, path, _b);
    });

    const res = await request(app).put("/api/inventory/OFFER-1/price").send({ price: 100 });

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("price too low");
    const audit = sqlite.db.prepare("SELECT * FROM promo_pricing_history WHERE offer_id = ?").get("OFFER-1");
    expect(audit).toBeUndefined();
  });

  it("Ozon API 抛异常时返回 500（不假装成功）", async () => {
    state.ozonShouldFail = true;
    const res = await request(app).put("/api/inventory/OFFER-1/price").send({ price: 1500 });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("ozon api down");
  });

  it("非法价格返回 400，不触达 Ozon", async () => {
    const res = await request(app).put("/api/inventory/OFFER-1/price").send({ price: -5 });

    expect(res.status).toBe(400);
    expect(state.ozonRequest).not.toHaveBeenCalled();
  });

  it("跨档自动迁仓：价格 ≤135¥ 迁到 Extra Small 仓（其余仓清零）", async () => {
    const res = await request(app).put("/api/inventory/OFFER-1/price").send({ price: 1000 }); // 1000₽/10 = 100 CNY ≤135

    expect(res.status).toBe(200);
    const stockCall = state.ozonRequest.mock.calls.find((c) => c[1] === "/v2/products/stocks");
    expect(stockCall).toBeDefined();
    const stocks = (stockCall?.[2] as { stocks: Array<{ warehouse_id: number; stock: number }> }).stocks;
    const target = stocks.find((s) => s.stock === 10);
    expect(target?.warehouse_id).toBe(1020005021424150); // XS = rfbs 总库存 8+2
    expect(stocks.filter((s) => s.stock === 0)).toHaveLength(5); // 其余 5 仓清零
  });

  it("跨档自动迁仓：价格 >135¥ 迁到 Small 仓（其余仓清零）", async () => {
    const res = await request(app).put("/api/inventory/OFFER-1/price").send({ price: 1500 }); // 150 CNY >135

    expect(res.status).toBe(200);
    const stockCall = state.ozonRequest.mock.calls.find((c) => c[1] === "/v2/products/stocks");
    const stocks = (stockCall?.[2] as { stocks: Array<{ warehouse_id: number; stock: number }> }).stocks;
    const target = stocks.find((s) => s.stock === 10);
    expect(target?.warehouse_id).toBe(1020005021424520); // Small
    expect(stocks.filter((s) => s.stock === 0)).toHaveLength(5);
  });

  it("跨档自动迁仓：635¥ 以上且 1-5kg 迁到 Premium Small（CLE陆运5，打窝船场景）", async () => {
    state.ozonRequest.mockImplementation((_m: unknown, path: unknown, b: unknown) => {
      if (path === "/v4/product/info/attributes") {
        return Promise.resolve({ result: [{ offer_id: "OFFER-1", weight: 3746 }] }); // 打窝船 3.7kg
      }
      return defaultOzonRequest(_m, path, b);
    });
    const res = await request(app).put("/api/inventory/OFFER-1/price").send({ price: 10300 }); // 1030 CNY >635

    expect(res.status).toBe(200);
    const stockCall = state.ozonRequest.mock.calls.find((c) => c[1] === "/v2/products/stocks");
    const stocks = (stockCall?.[2] as { stocks: Array<{ warehouse_id: number; stock: number }> }).stocks;
    const target = stocks.find((s) => s.stock === 10);
    expect(target?.warehouse_id).toBe(1020005027799150); // Premium Small = CLE陆运5
    expect(stocks.filter((s) => s.stock === 0)).toHaveLength(5);
  });

  it("跨档自动迁仓：135-635¥ 且 >2kg 迁到 Big 仓（CEL仓库3）", async () => {
    state.ozonRequest.mockImplementation((_m: unknown, path: unknown, b: unknown) => {
      if (path === "/v4/product/info/attributes") {
        return Promise.resolve({ result: [{ offer_id: "OFFER-1", weight: 2500 }] }); // 2.5kg
      }
      return defaultOzonRequest(_m, path, b);
    });
    const res = await request(app).put("/api/inventory/OFFER-1/price").send({ price: 3000 }); // 300 CNY

    expect(res.status).toBe(200);
    const stockCall = state.ozonRequest.mock.calls.find((c) => c[1] === "/v2/products/stocks");
    const stocks = (stockCall?.[2] as { stocks: Array<{ warehouse_id: number; stock: number }> }).stocks;
    const target = stocks.find((s) => s.stock === 10);
    expect(target?.warehouse_id).toBe(1020005021424710); // Big
  });

  it("迁仓失败不阻断：价格仍返回 200", async () => {
    state.ozonRequest.mockImplementation((_m: unknown, path: unknown, b: unknown) => {
      if (path === "/v2/products/stocks") return Promise.reject(new Error("warehouse api down"));
      if (path === "/v1/product/import/prices") {
        return Promise.resolve({ result: [{ offer_id: "OFFER-1", updated: true, errors: [] }] });
      }
      return defaultOzonRequest(_m, path, b);
    });

    const res = await request(app).put("/api/inventory/OFFER-1/price").send({ price: 1000 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, newPrice: 1000 });
  });
});
