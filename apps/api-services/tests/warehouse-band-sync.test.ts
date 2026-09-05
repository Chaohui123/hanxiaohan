// warehouse-band-sync 单测：档位判定 + 幂等覆盖写入
import { describe, it, expect } from "vitest";
import { syncWarehouseBands } from "../src/services/warehouse-band-sync.js";

function makeClient(opts: {
  products: Array<{ product_id: number; offer_id: string; archived?: boolean }>;
  prices: Record<string, number>;
  weights: Record<string, number>;
  stocks: Record<string, number>;
}) {
  const calls: Array<{ path: string; body: unknown }> = [];
  const client = {
    async request(_m: string, path: string, body: unknown) {
      calls.push({ path, body });
      const offerIds = (body as { filter?: { offer_id?: string[] } })?.filter?.offer_id || [];
      if (path === "/v3/product/list") {
        return { result: { items: opts.products.map((p) => ({ ...p, archived: !!p.archived })) } };
      }
      if (path === "/v5/product/info/prices") {
        return { items: offerIds.map((id) => ({ offer_id: id, price: { price: opts.prices[id] ?? 0 } })) };
      }
      if (path === "/v4/product/info/attributes") {
        return { result: offerIds.map((id) => ({ offer_id: id, weight: opts.weights[id] ?? 0 })) };
      }
      if (path === "/v4/product/info/stocks") {
        return {
          items: offerIds.map((id) => ({
            offer_id: id,
            stocks: [{ type: "rfbs", present: opts.stocks[id] ?? 0 }],
          })),
        };
      }
      if (path === "/v2/products/stocks") {
        const stocks = (body as { stocks: Array<{ offer_id: string; warehouse_id: number; stock: number }> }).stocks;
        return { result: stocks.map((s) => ({ offer_id: s.offer_id, updated: true, errors: [] })) };
      }
      throw new Error("unexpected " + path);
    },
  };
  return { client, calls };
}

describe("syncWarehouseBands", () => {
  it("按价格×重量分档并幂等覆盖 6 仓", async () => {
    const { client, calls } = makeClient({
      products: [
        { product_id: 1, offer_id: "XS-ITEM" },     // 82¥/150g → XS
        { product_id: 2, offer_id: "SM-ITEM" },     // 146.9¥/150g → SMALL
        { product_id: 3, offer_id: "BIG-ITEM" },    // 200¥/3000g → BIG
        { product_id: 4, offer_id: "PREM-ITEM" },   // 1000¥/3000g → PREM_S
        { product_id: 5, offer_id: "ARCHIVED", archived: true },
        { product_id: 6, offer_id: "ZERO-STOCK" },  // 无库存跳过
      ],
      prices: { "XS-ITEM": 82, "SM-ITEM": 146.9, "BIG-ITEM": 200, "PREM-ITEM": 1000, "ZERO-STOCK": 100 },
      weights: { "XS-ITEM": 150, "SM-ITEM": 150, "BIG-ITEM": 3000, "PREM-ITEM": 3000 },
      stocks: { "XS-ITEM": 30, "SM-ITEM": 25, "BIG-ITEM": 10, "PREM-ITEM": 5, "ZERO-STOCK": 0 },
    });
    const r = await syncWarehouseBands(client);
    expect(r.checked).toBe(5); // 归档品不检查
    expect(r.errors).toHaveLength(0);
    expect(r.skipped.join()).toContain("ZERO-STOCK");
    expect(r.migrated).toHaveLength(4);

    const write = calls.find((c) => c.path === "/v2/products/stocks");
    const stocks = (write?.body as { stocks: Array<{ offer_id: string; warehouse_id: number; stock: number }> }).stocks;
    const byOffer = (id: string) => stocks.filter((s) => s.offer_id === id);
    // 每品 6 仓全覆盖，目标仓=总库存，其余=0
    expect(byOffer("XS-ITEM")).toHaveLength(6);
    expect(byOffer("XS-ITEM").find((s) => s.warehouse_id === 1020005021424150)?.stock).toBe(30);
    expect(byOffer("SM-ITEM").find((s) => s.warehouse_id === 1020005021424520)?.stock).toBe(25);
    expect(byOffer("BIG-ITEM").find((s) => s.warehouse_id === 1020005021424710)?.stock).toBe(10);
    expect(byOffer("PREM-ITEM").find((s) => s.warehouse_id === 1020005027799150)?.stock).toBe(5);
    // 非目标仓清零
    expect(byOffer("XS-ITEM").filter((s) => s.warehouse_id !== 1020005021424150).every((s) => s.stock === 0)).toBe(true);
  });

  it("全部无库存时不写 stocks 接口", async () => {
    const { client, calls } = makeClient({
      products: [{ product_id: 1, offer_id: "A" }],
      prices: { A: 100 }, weights: { A: 100 }, stocks: { A: 0 },
    });
    await syncWarehouseBands(client);
    expect(calls.some((c) => c.path === "/v2/products/stocks")).toBe(false);
  });
});
