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
        { offer_id: "OFFER-1", stocks: [{ present: 8 }, { present: 2 }] },
        { offer_id: "OFFER-2", stocks: [{ present: 5 }] },
        { offer_id: "OFFER-3", stocks: [{ present: 0 }] },
      ],
    });
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

  sqlite.db.exec("DELETE FROM product_performance; DELETE FROM sku_1688_mapping;");
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
      price: 1500,
      stock: 10, // 8 + 2 汇总
      cost: 50.5, // sku_1688_mapping 匹配
      rating: 0,
      orders: 0,
      revenue: 0,
      quantity: 10,
    });

    const item2 = res.body.items.find((i: Record<string, unknown>) => i.offerId === "OFFER-2");
    expect(item2).toMatchObject({ offerId: "OFFER-2", price: 3200.5, stock: 5, cost: 0 }); // 无映射 → cost 0
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
      price: 1500,
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
