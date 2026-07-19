import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  exec: vi.fn(), run: vi.fn().mockResolvedValue({ changes: 1 }), all: vi.fn().mockResolvedValue([] as Record<string, unknown>[]),
}));

vi.mock("../../src/db/connection.js", () => ({
  getDb: vi.fn().mockResolvedValue(mockDb),
  serializedWrite: vi.fn((fn: () => Promise<unknown>) => fn()),
}));
vi.mock("@onzo/ozon-order", () => ({ OzonOrderClient: vi.fn(() => ({ shipOrder: vi.fn() })) }));
vi.mock("@onzo/logistics", () => ({ getLogisticsProvider: vi.fn().mockResolvedValue(null), selectBestProvider: vi.fn().mockResolvedValue(null) }));
vi.mock("../../src/services/notifier.js", () => ({ notifier: { notify: vi.fn() } }));
vi.mock("../../src/services/notification-events.js", () => ({ emitEvent: vi.fn().mockResolvedValue(undefined), EVENT_KEYS: { SHIPMENT_FAILED: "SF", ORDER_SHIPPED: "OS" } }));

import { batchShipOrders } from "../../src/services/auto-ship.js";
const mockClient = {} as Parameters<typeof batchShipOrders>[0];

describe("batchShipOrders", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns empty when no pending orders", async () => {
    mockDb.all.mockResolvedValue([]);
    const r = await batchShipOrders(mockClient);
    expect(r.total).toBe(0);
  });

  it("skips invalid product json", async () => {
    mockDb.all.mockResolvedValue([{ posting_number: "P1", store_id: "s1", raw_json: "bad" }]);
    const r = await batchShipOrders(mockClient);
    expect(r.skipped).toBe(1);
  });

  it("ships valid orders", async () => {
    mockDb.all.mockResolvedValue([{ posting_number: "P2", store_id: "s1", raw_json: '{"products":[{"sku":100,"quantity":2}]}' }]);
    const r = await batchShipOrders(mockClient);
    expect(r.shipped).toBe(1);
  });
});
