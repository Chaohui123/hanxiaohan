// scoreAllProducts 订单契约回归（2026-10-22 实证三连断）：
// ① /api/orders 返回 { success, data: [...] }，不是 { orders: [...] }——按 orders 键取恒为空，销量/astra 条款1·5 全哑
// ② 行的商品列表是 products_json 字符串（内含 offerId），不是 items 数组
// ③ v4 订单列表无 created_at → createdAt 为 null，需回退 synced_at
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ApiConfig } from "../src/api-client.js";

const mocks = vi.hoisted(() => ({
  products: vi.fn(),
  getPrices: vi.fn(),
  orders: vi.fn(),
}));

vi.mock("../src/api-client.js", () => ({
  promoApi: {
    exchangeRate: vi.fn().mockResolvedValue({ rate: 12 }),
    stores: vi.fn().mockResolvedValue({ items: [] }),
    orders: mocks.orders,
    products: mocks.products,
  },
  competitorApi: {
    getPrices: mocks.getPrices,
  },
}));

const config: ApiConfig = { apiBase: "http://localhost:3000", apiKey: "test-key" };

function baseItem(extra: Record<string, unknown> = {}) {
  return {
    offerId: "A1", name: "Test Product", price: 1000, stock: 10,
    cost: 30, weight: 0.2, rating: 4.0, ...extra,
  };
}

beforeEach(() => {
  mocks.products.mockReset();
  mocks.getPrices.mockReset();
  mocks.orders.mockReset();
  mocks.products.mockResolvedValue({ items: [baseItem()] });
  mocks.getPrices.mockResolvedValue({ prices: [] });
});

describe("scoreAllProducts — /api/orders 真实契约", () => {
  it("{data:[{createdAt, products_json 字符串}]} → 近7d销量被追踪（salesGrowth7d=100）", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    mocks.orders.mockResolvedValue({
      success: true,
      data: [{
        posting_number: "X-1",
        createdAt: twoDaysAgo,
        products_json: JSON.stringify([{ offerId: "A1", sku: 1, quantity: 1 }]),
      }],
    });

    const { scoreAllProducts } = await import("../src/decision-engine.js");
    const scored = await scoreAllProducts(config);

    expect(scored).toHaveLength(1);
    expect(scored[0].salesGrowth7d).toBe(100); // recent=1, prev=0 → 100
  });

  it("createdAt 为 null 时回退 synced_at（v4 无 created_at 的存量 NULL 行）", async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    mocks.orders.mockResolvedValue({
      success: true,
      data: [{
        posting_number: "X-2",
        createdAt: null,
        synced_at: threeDaysAgo,
        products_json: JSON.stringify([{ offerId: "A1", sku: 1, quantity: 1 }]),
      }],
    });

    const { scoreAllProducts } = await import("../src/decision-engine.js");
    const scored = await scoreAllProducts(config);

    expect(scored[0].salesGrowth7d).toBe(100);
  });

  it("历史 {orders:[...]} 契约仍兼容", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    mocks.orders.mockResolvedValue({
      orders: [{ createdAt: yesterday, items: [{ offerId: "A1" }] }],
    });

    const { scoreAllProducts } = await import("../src/decision-engine.js");
    const scored = await scoreAllProducts(config);

    expect(scored[0].salesGrowth7d).toBe(100);
  });

  it("无订单商品 salesGrowth7d=0（兜底不炸）", async () => {
    mocks.orders.mockResolvedValue({ success: true, data: [] });

    const { scoreAllProducts } = await import("../src/decision-engine.js");
    const scored = await scoreAllProducts(config);

    expect(scored[0].salesGrowth7d).toBe(0);
  });
});
