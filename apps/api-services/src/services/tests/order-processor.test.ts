import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  exec: vi.fn(), run: vi.fn().mockResolvedValue({ changes: 1 }), all: vi.fn().mockResolvedValue([] as Record<string, unknown>[]),
}));

vi.mock("../../db/connection.js", () => ({
  getDb: vi.fn().mockResolvedValue(mockDb),
  serializedWrite: vi.fn((fn: () => Promise<unknown>) => fn()),
}));
vi.mock("@onzo/ozon-order/inventory", () => ({
  InventoryManager: vi.fn(() => ({ deduct: vi.fn().mockResolvedValue({ success: true }), restore: vi.fn() })),
}));
vi.mock("../notifier.js", () => ({ notifier: { notify: vi.fn().mockResolvedValue(undefined) } }));

import { processNewOrder, processCancelledOrder, processStatusChange } from "../order-processor.js";

const mockOrder = { postingNumber: "P001", orderId: 123, status: "awaiting_packaging" as const, createdAt: "2026-01-01", products: [{ sku: 100, name: "T", quantity: 2, price: 100, offerId: "O1" }], price: 200, commission: 20, payout: 180, buyerName: "T", buyerPhone: "+7", inProcessAt: "", deliveryMethod: "", trackingNumber: "", orderNumber: "O1", buyerEmail: "" };

describe("processNewOrder", () => {
  beforeEach(() => vi.clearAllMocks());
  it("processes a new order", async () => {
    const r = await processNewOrder(mockOrder, "store_1");
    expect(r.success).toBe(true);
  });
  it("fails when DB unavailable", async () => {
    const m = await import("../../db/connection.js");
    vi.mocked(m.getDb).mockResolvedValueOnce(null);
    expect((await processNewOrder(mockOrder, "store_1")).success).toBe(false);
  });
});

describe("processCancelledOrder", () => {
  it("processes cancellation", async () => {
    mockDb.all.mockResolvedValueOnce([{ offer_id: "O1", sku: 100, qty: 2 }]);
    const r = await processCancelledOrder("P001", "store_1");
    expect(r.success).toBe(true);
  });
});

describe("processStatusChange", () => {
  it("updates status", async () => {
    const r = await processStatusChange("P001", "delivering");
    expect(r.success).toBe(true);
  });
});
