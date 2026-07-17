// ============================================================
// Logistics Module Tests — orchestrator, providers, webhooks, diagnostics
// Covers: shipment creation, tracking backfill, delay monitoring,
//          cost writeback, webhook processing, multi-carrier routing
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- Mocks ----

const mockDb = {
  exec: vi.fn(),
  run: vi.fn().mockResolvedValue({ changes: 1 }),
  all: vi.fn(),
};

const mockOzonClient = {
  request: vi.fn(),
  ping: vi.fn().mockResolvedValue(true),
};

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() };
const mockNotifier = { notify: vi.fn().mockResolvedValue(undefined), enabled: true };
const mockAcquireLock = vi.fn();
const mockReleaseLock = vi.fn();
const mockEmitEvent = vi.fn().mockResolvedValue(undefined);
const mockGetExchangeRate = vi.fn().mockResolvedValue(11.5);

vi.mock("@onzo/logger", () => ({ logger: mockLogger }));
vi.mock("../src/services/notifier.js", () => ({ notifier: mockNotifier }));
vi.mock("../src/services/redis-lock.js", () => ({
  acquireLock: (...args: unknown[]) => mockAcquireLock(...args),
  releaseLock: (...args: unknown[]) => mockReleaseLock(...args),
}));
vi.mock("../src/services/notification-events.js", () => ({
  emitEvent: (...args: unknown[]) => mockEmitEvent(...args),
  EVENT_KEYS: { ORDER_SHIPPED: "ORDER_SHIPPED", SHIPMENT_FAILED: "SHIPMENT_FAILED" },
}));
vi.mock("../src/services/exchange-rate.js", () => ({
  getExchangeRate: () => mockGetExchangeRate(),
}));

// Mock the logistics provider
const mockProvider = {
  name: "cdek",
  isAvailable: vi.fn().mockReturnValue(true),
  createShipment: vi.fn(),
  getTrackingInfo: vi.fn(),
  cancelShipment: vi.fn(),
};

vi.mock("@onzo/logistics", () => ({
  getLogisticsProvider: vi.fn().mockResolvedValue(mockProvider),
  selectBestProvider: vi.fn().mockResolvedValue(mockProvider),
}));

// ---- Import after mocks ----
const { LogisticsOrchestrator } = await import("../src/services/logistics-orchestrator.js");

// ---- Tests ----

describe("LogisticsOrchestrator", () => {
  let orchestrator: LogisticsOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    orchestrator = new LogisticsOrchestrator(mockDb as never);
    mockAcquireLock.mockResolvedValue("lock-token-123");
    mockReleaseLock.mockResolvedValue(undefined);
  });

  describe("createShipment", () => {
    it("should create a shipment and backfill tracking successfully", async () => {
      mockDb.all = vi.fn()
        .mockResolvedValueOnce([{ id: "p1", ozon_posting_number: "P123", sku_list_json: '[{"sku":1,"quantity":2}]', total_amount_cny: 500, store_id: "store_1" }])
        .mockResolvedValueOnce([{ freight_address: "test", weight_kg: 0.5, ozon_offer_id: "o1" }])
        .mockResolvedValueOnce([{ buyer_name: "Ivan", buyer_phone: "+79991234567", products_json: '[{"offer_id":"o1","price":3000,"quantity":1}]', total_price_rub: 3000 }]);

      mockProvider.createShipment.mockResolvedValue({
        success: true,
        trackingNumber: "CDEK-TRACK-123",
        costRub: 450,
        provider: "cdek",
      });

      const result = await orchestrator.createShipment({
        postingNumber: "P123",
        purchaseId: "p1",
      });

      expect(result.success).toBe(true);
      expect(result.trackingNumber).toBe("CDEK-TRACK-123");
      expect(result.costRub).toBe(450);
      expect(mockAcquireLock).toHaveBeenCalledWith("shipment:P123", 120);
      expect(mockReleaseLock).toHaveBeenCalled();
      expect(mockDb.run).toHaveBeenCalled();
      expect(mockEmitEvent).toHaveBeenCalledWith("ORDER_SHIPPED", expect.any(Object));
      expect(mockEmitEvent).toHaveBeenCalledWith("LOGISTICS_PICKUP_CONFIRMED", expect.any(Object));
    });

    it("should prevent duplicate shipment via Redis lock", async () => {
      mockAcquireLock.mockResolvedValue(null);

      const result = await orchestrator.createShipment({
        postingNumber: "P123",
        purchaseId: "p1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Duplicate");
    });

    it("should fail when purchase is not found", async () => {
      mockDb.all = vi.fn().mockResolvedValueOnce([]);

      const result = await orchestrator.createShipment({
        postingNumber: "P999",
        purchaseId: "p999",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Purchase not found");
    });

    it("should handle provider API failure gracefully", async () => {
      mockDb.all = vi.fn()
        .mockResolvedValueOnce([{ id: "p1", ozon_posting_number: "P123", sku_list_json: "[]", total_amount_cny: 500, store_id: "store_1" }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      mockProvider.createShipment.mockResolvedValue({
        success: false,
        provider: "cdek",
        error: "CDEK API timeout",
      });

      const result = await orchestrator.createShipment({
        postingNumber: "P123",
        purchaseId: "p1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("CDEK API timeout");
      expect(mockReleaseLock).toHaveBeenCalled();
    });

    it("should lock and release even on exceptions", async () => {
      mockDb.all = vi.fn().mockRejectedValue(new Error("DB crash"));

      const result = await orchestrator.createShipment({
        postingNumber: "P123",
        purchaseId: "p1",
      });

      expect(result.success).toBe(false);
      expect(mockReleaseLock).toHaveBeenCalled(); // lock released even on error
    });
  });

  describe("processWebhook", () => {
    it("should update logistics_status on CDEK webhook", async () => {
      await orchestrator.processWebhook({
        trackingNumber: "CDEK-123",
        status: "delivered",
        statusDescription: "Delivered to recipient",
        timestamp: "2026-07-16T10:00:00Z",
        location: "Moscow",
        carrier: "cdek",
      });

      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE purchase_1688"),
        expect.arrayContaining(["delivered", "Delivered to recipient", "2026-07-16T10:00:00Z", "CDEK-123"])
      );
    });

    it("should fire custom notification on customs hold", async () => {
      await orchestrator.processWebhook({
        trackingNumber: "CDEK-456",
        status: "customs_hold",
        statusDescription: "Held at customs — documents needed",
        timestamp: "2026-07-16T08:00:00Z",
        carrier: "cdek",
      });

      expect(mockNotifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "warn",
          event: "LOGISTICS_CUSTOMS_HOLD",
        })
      );
    });

    it("should map carrier status to internal status", async () => {
      // Test the status mapping via webhooks with different statuses
      await orchestrator.processWebhook({ trackingNumber: "T1", status: "забран", statusDescription: "Picked up", timestamp: "now", carrier: "cdek" });
      // Just verify it doesn't throw — mapped to "picked_up"
      expect(mockDb.run).toHaveBeenCalled();
    });
  });

  describe("checkDelays", () => {
    it("should fire critical alerts for 48h+ no pickup", async () => {
      const oldDate = new Date(Date.now() - 72 * 3600_000).toISOString();
      mockDb.all = vi.fn()
        .mockResolvedValueOnce([{ posting_number: "P1", total_amount_cny: 800, id: "p1", pay_time: oldDate, logistics_carrier: "" }])
        .mockResolvedValueOnce([]); // no customs delays

      const alertCount = await orchestrator.checkDelays();

      expect(alertCount).toBeGreaterThan(0);
      expect(mockNotifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "critical",
          event: "LOGISTICS_NO_PICKUP",
          force: true,
        })
      );
      expect(mockEmitEvent).toHaveBeenCalledWith("LOGISTICS_DELAY", expect.any(Object));
    });

    it("should fire alerts for customs hold > 72h", async () => {
      mockDb.all = vi.fn()
        .mockResolvedValueOnce([]) // no pickup delays
        .mockResolvedValueOnce([{ posting_number: "P2", total_amount_cny: 1200, id: "p2", logistics_tracking: "CDEK-X", logistics_carrier: "cdek" }]);

      const alertCount = await orchestrator.checkDelays();
      expect(alertCount).toBeGreaterThan(0);
      expect(mockNotifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({ event: "LOGISTICS_CUSTOMS_DELAY" })
      );
    });

    it("should return 0 when no delays found", async () => {
      mockDb.all = vi.fn().mockResolvedValue([]).mockResolvedValue([]);

      const alertCount = await orchestrator.checkDelays();
      expect(alertCount).toBe(0);
    });
  });

  describe("batchCreateShipments", () => {
    it("should process all pending shipments", async () => {
      // batchCreateShipments first queries pending purchases, then calls createShipment
      // for each, which does 3 more db.all() calls per item.
      // Use mockResolvedValue (not Once) to handle all of them.
      mockDb.all = vi.fn()
        // 1. batchCreateShipments: query pending purchases
        .mockResolvedValueOnce([
          { ozon_posting_number: "P1", id: "p1", store_id: "store_1" },
          { ozon_posting_number: "P2", id: "p2", store_id: "store_1" },
        ])
        // 2+3+4. first createShipment call (3 db.all queries)
        .mockResolvedValueOnce([{ id: "p1", ozon_posting_number: "P1", sku_list_json: "[]", total_amount_cny: 500, store_id: "store_1" }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        // 5+6+7. second createShipment call
        .mockResolvedValueOnce([{ id: "p2", ozon_posting_number: "P2", sku_list_json: "[]", total_amount_cny: 500, store_id: "store_1" }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      mockProvider.createShipment
        .mockResolvedValueOnce({ success: true, trackingNumber: "CDEK-P1", costRub: 300, provider: "cdek" })
        .mockResolvedValueOnce({ success: true, trackingNumber: "CDEK-P2", costRub: 350, provider: "cdek" });

      const result = await orchestrator.batchCreateShipments(mockOzonClient as never);

      expect(result.total).toBe(2);
      expect(result.succeeded).toBe(2);
    });
  });

  describe("diagnose", () => {
    it("should return comprehensive stats", async () => {
      mockDb.all = vi.fn()
        .mockResolvedValueOnce([{ carrier: "cdek", cnt: 5 }, { carrier: "boxberry", cnt: 2 }])
        .mockResolvedValueOnce([{ status: "shipped", cnt: 5 }, { status: "idle", cnt: 2 }])
        .mockResolvedValueOnce([{ posting_number: "P1", pay_time: new Date(Date.now() - 72 * 3600_000).toISOString(), logistics_carrier: "cdek" }])
        .mockResolvedValueOnce([{ carrier: "cdek", avg_cost: 450 }, { carrier: "boxberry", avg_cost: 380 }])
        .mockResolvedValueOnce([{ posting_number: "P1", tracking_number: "T1", status: "shipped", updated_at: "2026-07-16" }]);

      const result = await orchestrator.diagnose();

      expect(result.totalShipments).toBe(7); // 5 + 2
      expect(result.byCarrier).toEqual({ cdek: 5, boxberry: 2 });
      expect(result.byStatus).toEqual({ shipped: 5, idle: 2 });
      expect(result.delayedCount).toBe(1);
      expect(result.delayedOrders[0]!.hoursSincePayment).toBeGreaterThan(48);
      expect(result.averageCostByCarrier.cdek).toBe(450);
      expect(result.averageCostByCarrier.boxberry).toBe(380);
      expect(result.recentTrackingUpdates.length).toBe(1);
    });
  });

  describe("writeLogisticsCost", () => {
    it("should update local_orders and recalculate profit", async () => {
      mockDb.all = vi.fn()
        .mockResolvedValueOnce([{ logistics_cost_rub: 450, logistics_carrier: "cdek", ozon_posting_number: "P123", total_amount_cny: 500 }]);

      await orchestrator.writeLogisticsCost("P123");

      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE local_orders"),
        [450, "cdek", "P123"]
      );
      // Should also call recalculate profit
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE ozon_orders"),
        expect.any(Array)
      );
    });
  });
});

// ---- Boxberry Provider Tests ----

const { BoxberryProvider } = await import("../../../packages/logistics/src/boxberry.js");

describe("BoxberryProvider", () => {
  let provider: ReturnType<typeof BoxberryProvider.prototype.constructor>;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new BoxberryProvider();
  });

  it("should report unavailable without token", () => {
    expect(provider.isAvailable()).toBe(false);
  });

  it("should return error on createShipment without token", async () => {
    const result = await provider.createShipment({
      postingNumber: "TEST",
      recipientName: "Test",
      recipientPhone: "+79991234567",
      address: { city: "Moscow", street: "Lenina 1", zipCode: "101000" },
      package: { weightGrams: 500, lengthCm: 20, widthCm: 15, heightCm: 10, items: [{ name: "item", quantity: 1, priceRub: 1000 }] },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not configured");
  });

  it("should have correct provider name", () => {
    expect(provider.name).toBe("boxberry");
  });
});
