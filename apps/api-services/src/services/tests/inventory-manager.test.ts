import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  exec: vi.fn(),
  run: vi.fn().mockResolvedValue({ changes: 1 }),
  all: vi.fn().mockResolvedValue([] as Record<string, unknown>[]),
}));

vi.mock("../../db/connection.js", () => ({
  getDb: vi.fn().mockResolvedValue(mockDb),
  serializedWrite: vi.fn((fn: () => Promise<unknown>) => fn()),
}));
vi.mock("../notification-events.js", () => ({ emitEvent: vi.fn(), EVENT_KEYS: { STOCK_OUT: "STOCK_OUT" } }));

import { InventoryManager } from "../inventory-manager.js";

describe("InventoryManager", () => {
  let mgr: InventoryManager;
  beforeEach(() => { vi.clearAllMocks(); mgr = new InventoryManager(); });

  it("setStock updates inventory", async () => {
    await mgr.setStock("OFFER1", 100, 50);
    expect(mockDb.run).toHaveBeenCalled();
  });

  it("getItem returns null when not found", async () => {
    mockDb.all.mockResolvedValue([]);
    expect(await mgr.getItem("OFFER1", 100)).toBeNull();
  });

  it("getItem returns item when found", async () => {
    mockDb.all.mockResolvedValue([{ offer_id: "OFFER1", sku: 100, stock_available: 50, stock_reserved: 0, updated_at: "2026-01-01" }]);
    const item = await mgr.getItem("OFFER1", 100);
    expect(item).not.toBeNull();
    expect(item!.stockAvailable).toBe(50);
  });

  it("getAlerts returns low-stock alerts", async () => {
    mockDb.all.mockResolvedValue([
      { offer_id: "O1", sku: 100, stock_available: 2 },
      { offer_id: "O2", sku: 200, stock_available: 0 },
    ]);
    const alerts = await mgr.getAlerts(5);
    expect(alerts.length).toBe(2);
    expect(alerts[0].alertLevel).toBe("warning");
    expect(alerts[1].alertLevel).toBe("critical");
  });

  it("getAllItems returns all inventory", async () => {
    mockDb.all.mockResolvedValue([{ offer_id: "O1", sku: 1, stock_available: 10, stock_reserved: 2, updated_at: "2026-01-01" }]);
    expect((await mgr.getAllItems()).length).toBe(1);
  });
});
