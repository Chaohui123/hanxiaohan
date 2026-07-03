import { describe, it, expect } from "vitest";
import { InventoryManager } from "../src/inventory.js";

describe("InventoryManager", () => {
  it("setStock and getStock work correctly", async () => {
    const rows: Record<string, unknown>[] = [];
    const db = {
      run: async (_s: string, p?: unknown[]) => {
        if (_s.includes("INSERT OR REPLACE")) {
          const idx = rows.findIndex((r) => r.offerId === p?.[0] && r.sku === p?.[1]);
          if (idx >= 0) rows.splice(idx, 1);
          rows.push({ offerId: p?.[0], sku: p?.[1], stockAvailable: p?.[2], stockReserved: 0, updatedAt: "" });
        }
      },
      all: async (_s: string, p?: unknown[]) => rows.filter((r) => r.offerId === p?.[0] && r.sku === p?.[1]),
    };
    const mgr = new InventoryManager(db);
    await mgr.setStock("SKU1", 100, 50);
    const stock = await mgr.getStock("SKU1", 100);
    expect(stock?.stockAvailable).toBe(50);
  });

  it("deduct returns success for sufficient stock", async () => {
    const rows = [{ offerId: "SKU2", sku: 200, stockAvailable: 30, stockReserved: 0, updatedAt: "" }];
    const db = {
      run: async () => {},
      all: async (_s: string, p?: unknown[]) => rows.filter((r) => r.offerId === p?.[0] && r.sku === p?.[1]),
    };
    const mgr = new InventoryManager(db);
    const r = await mgr.deduct("P001", [{ offerId: "SKU2", sku: 200, quantity: 5 }]);
    expect(r.success).toBe(true);
  });

  it("deduct returns failure for insufficient stock", async () => {
    const db = {
      run: async () => {},
      all: async () => [] as Record<string, unknown>[],
    };
    const mgr = new InventoryManager(db);
    const r = await mgr.deduct("P002", [{ offerId: "SKU3", sku: 300, quantity: 100 }]);
    expect(r.success).toBe(false);
  });

  it("handles multi-item stock lifecycle", async () => {
    const rows: Record<string, unknown>[] = [
      { offerId: "O1", sku: 1, stockAvailable: 20, stockReserved: 0, updatedAt: "" },
    ];
    const db = {
      run: async () => {},
      all: async (_s: string, p?: unknown[]) => rows.filter((r) => r.offerId === p?.[0] && r.sku === p?.[1]),
    };
    const mgr = new InventoryManager(db);

    // Deduct 5
    rows[0].stockAvailable = 15; rows[0].stockReserved = 5;
    let r = await mgr.deduct("P1", [{ offerId: "O1", sku: 1, quantity: 5 }]);

    // Restore 5
    rows[0].stockAvailable = 20; rows[0].stockReserved = 0;
    await mgr.restore("P1", [{ offerId: "O1", sku: 1, quantity: 5 }]);

    expect(r.success).toBe(true);
  });
});
