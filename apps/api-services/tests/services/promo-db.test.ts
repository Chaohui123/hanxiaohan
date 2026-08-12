// promo-db — 真实订单数据源测试（内存 SQLite + mock 广告服务）
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSqliteTestDb } from "../helpers/test-db.js";

const mockGetAdDailyStats = vi.fn();
vi.mock("../../src/services/ozon-ads.js", () => ({
  getAdDailyStats: (...args: unknown[]) => mockGetAdDailyStats(...args),
}));

let dbCtx: ReturnType<typeof createSqliteTestDb>;

vi.mock("../../src/db/connection.js", () => ({
  getDb: vi.fn().mockImplementation(() => Promise.resolve(dbCtx.adapter)),
}));

import { queryDailyStats, queryOrdersByDay, queryPromoCost, querySalesRanking } from "../../src/db/promo-db.js";

const DDL = `
CREATE TABLE ozon_orders (
  id TEXT PRIMARY KEY, store_id TEXT NOT NULL DEFAULT 'store_1',
  posting_number TEXT NOT NULL, order_id INTEGER NOT NULL,
  order_number TEXT, status TEXT NOT NULL,
  created_at_ozon TEXT, products_json TEXT NOT NULL,
  total_price_rub REAL DEFAULT 0, synced_at TEXT, updated_at TEXT
)`;

function insertOrder(o: { id: string; status: string; createdAt: string; total: number; productsJson: string }) {
  return dbCtx.adapter.run(
    "INSERT INTO ozon_orders (id, store_id, posting_number, order_id, status, created_at_ozon, products_json, total_price_rub) VALUES (?, 'store_1', ?, 1, ?, ?, ?, ?)",
    [o.id, `PN-${o.id}`, o.status, o.createdAt, o.productsJson, o.total],
  );
}

describe("promo-db real order queries", () => {
  beforeEach(async () => {
    dbCtx = createSqliteTestDb();
    await dbCtx.adapter.exec(DDL);
    vi.clearAllMocks();

    await insertOrder({
      id: "o1", status: "awaiting_deliver", createdAt: "2026-08-10T10:00:00.000Z", total: 1500,
      productsJson: JSON.stringify([
        { offerId: "A1", name: "商品A", quantity: 2, price: 500 },
        { offerId: "B2", name: "商品B", quantity: 1, price: 500 },
      ]),
    });
    await insertOrder({
      id: "o2", status: "delivered", createdAt: "2026-08-10T15:00:00.000Z", total: 800,
      productsJson: JSON.stringify([{ offerId: "A1", name: "商品A", quantity: 1, price: 800 }]),
    });
    // 取消单：所有统计都应排除
    await insertOrder({
      id: "o3", status: "cancelled", createdAt: "2026-08-10T18:00:00.000Z", total: 9999,
      productsJson: JSON.stringify([{ offerId: "C3", name: "商品C", quantity: 5, price: 1999 }]),
    });
    await insertOrder({
      id: "o4", status: "awaiting_packaging", createdAt: "2026-08-11T09:00:00.000Z", total: 300,
      productsJson: JSON.stringify([{ offerId: "B2", name: "商品B", quantity: 1, price: 300 }]),
    });
  });

  it("queryDailyStats aggregates real orders, excludes cancelled, counts cancellations", async () => {
    const s = await queryDailyStats("2026-08-10");
    expect(s.orders).toBe(2);
    expect(s.revenue).toBe(2300);
    expect(s.avgOrderValue).toBe(1150);
    expect(s.cancelledOrders).toBe(1);
  });

  it("queryDailyStats returns zeros for a day without orders", async () => {
    const s = await queryDailyStats("2026-08-12");
    expect(s).toEqual({ orders: 0, revenue: 0, avgOrderValue: 0, cancelledOrders: 0 });
  });

  it("queryOrdersByDay groups by date and skips cancelled", async () => {
    const days = await queryOrdersByDay("2026-08-09", "2026-08-12");
    expect(days).toEqual([
      { date: "2026-08-10", orders: 2, revenue: 2300 },
      { date: "2026-08-11", orders: 1, revenue: 300 },
    ]);
  });

  it("querySalesRanking aggregates products_json per offerId, sorted by orders", async () => {
    // 用当前时间确保落在 cutoff 窗口内
    const now = new Date().toISOString();
    await insertOrder({
      id: "o5", status: "delivered", createdAt: now, total: 1000,
      productsJson: JSON.stringify([
        { offerId: "D4", name: "商品D", quantity: 2, price: 400 },
        { offerId: "E5", name: "商品E", quantity: 1, price: 200 },
      ]),
    });
    await insertOrder({
      id: "o6", status: "awaiting_deliver", createdAt: now, total: 600,
      productsJson: JSON.stringify([{ offerId: "D4", name: "商品D", quantity: 1, price: 600 }]),
    });
    // 损坏的 JSON 行应被跳过而不是抛错
    await insertOrder({ id: "o7", status: "delivered", createdAt: now, total: 100, productsJson: "not-json" });

    const ranking = await querySalesRanking(7);
    const d = ranking.find((r) => r.offerId === "D4");
    const e = ranking.find((r) => r.offerId === "E5");
    expect(d).toEqual({ offerId: "D4", name: "商品D", orders: 3, revenue: 1400 });
    expect(e).toEqual({ offerId: "E5", name: "商品E", orders: 1, revenue: 200 });
    expect(ranking.indexOf(d!)).toBeLessThan(ranking.indexOf(e!));
    // 取消单商品不进入榜单
    expect(ranking.find((r) => r.offerId === "C3")).toBeUndefined();
  });

  it("queryPromoCost returns null ad fields when ads API unavailable", async () => {
    mockGetAdDailyStats.mockResolvedValue(null);
    const c = await queryPromoCost("2026-08-09", "2026-08-12");
    expect(c.totalRevenue).toBe(2600); // 1500 + 800 + 300，排除取消单
    expect(c.adSpend).toBeNull();
    expect(c.paidRevenue).toBeNull();
    expect(c.organicRevenue).toBeNull();
    expect(c.roi).toBeNull();
  });

  it("queryPromoCost computes paid/organic/roi from real ad stats", async () => {
    mockGetAdDailyStats.mockResolvedValue({ spendRub: 400, shows: 1000, clicks: 50, adOrders: 2, adRevenueRub: 900 });
    const c = await queryPromoCost("2026-08-09", "2026-08-12");
    expect(c.adSpend).toBe(400);
    expect(c.paidRevenue).toBe(900);
    expect(c.organicRevenue).toBe(1700);
    expect(c.roi).toBeCloseTo(2.25, 2);
  });

  it("queryPromoCost clamps organic at 0 and returns null roi when spend is 0", async () => {
    mockGetAdDailyStats.mockResolvedValue({ spendRub: 0, shows: 0, clicks: 0, adOrders: 0, adRevenueRub: 99999 });
    const c = await queryPromoCost("2026-08-09", "2026-08-12");
    expect(c.organicRevenue).toBe(0);
    expect(c.roi).toBeNull();
  });
});
