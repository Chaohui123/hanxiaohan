// ============================================================
// Transition Logistics Tests — 跨境巴士 semi-auto workflow
// Covers: export generation, tracking import, billing import,
//          dashboard stats, overdue alert checks
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Mocks ----

const mockDb = {
  exec: vi.fn(),
  run: vi.fn().mockResolvedValue({ changes: 1 }),
  all: vi.fn(),
};

const mockOzonClient = { request: vi.fn(), ping: vi.fn().mockResolvedValue(true) };
const mockNotifier = { notify: vi.fn().mockResolvedValue(undefined) };
const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

vi.mock("@onzo/logger", () => ({ logger: mockLogger }));
vi.mock("../src/services/notifier.js", () => ({ notifier: mockNotifier }));
vi.mock("@onzo/ozon-order", () => ({
  OzonOrderClient: vi.fn().mockImplementation(() => ({
    shipOrder: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ---- Imports ----
const { TransitionLogisticsService, KuajingBusAdapter } = await import("../src/services/transition-logistics.js");

describe("KuajingBusAdapter", () => {
  const adapter = new KuajingBusAdapter();

  it("should export orders with correct 跨境巴士 headers", () => {
    const orders = [{
      postingNumber: "P123-456", orderNumber: "ONZ-001",
      recipientName: "Иван Петров", recipientPhone: "+79991234567",
      address: "Россия, г. Москва", productName: "Чехол для телефона", weightKg: 0.5,
      sku: 12345, domesticTracking: "SF1234567890", priceRub: 1500, costCny: 80,
      paymentStatus: "paid",
    }];

    const result = adapter.exportOrders(orders);

    expect(result.headers).toContain("Ozon订单号");
    expect(result.headers).toContain("收件人俄文姓名");
    expect(result.headers).toContain("1688国内快递单号");
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]!["Ozon订单号"]).toBe("P123-456");
    expect(result.rows[0]!["收件人俄文姓名"]).toBe("Иван Петров");
    expect(result.rows[0]!["1688国内快递单号"]).toBe("SF1234567890");
    expect(result.filename).toContain("跨境巴士");
  });

  it("should parse tracking import with mixed column names", () => {
    const rows = [
      { "Ozon订单号": "P001", "国际运单号": "CDEK-ABC123", "物流商": "cdek", "重量(KG)": "1.2", "运费(RUB)": "450" },
      { "ozon_posting_number": "P002", "tracking_number": "RUPOST-XYZ", "carrier": "russian_post", "weight": "0.8" },
    ];

    const result = adapter.parseTrackingImport(rows);

    expect(result.length).toBe(2);
    expect(result[0]!.postingNumber).toBe("P001");
    expect(result[0]!.trackingNumber).toBe("CDEK-ABC123");
    expect(result[0]!.carrier).toBe("cdek");
    expect(result[0]!.costRub).toBe(450);
    expect(result[1]!.postingNumber).toBe("P002");
    expect(result[1]!.trackingNumber).toBe("RUPOST-XYZ");
  });

  it("should skip rows without postingNumber or trackingNumber", () => {
    const rows = [
      { "Ozon订单号": "", "国际运单号": "CDEK-ABC" },
      { "Ozon订单号": "P003", "国际运单号": "" },
      { "Ozon订单号": "P004", "国际运单号": "CDEK-DEF" },
    ];

    const result = adapter.parseTrackingImport(rows);
    expect(result.length).toBe(1);
    expect(result[0]!.postingNumber).toBe("P004");
  });

  it("should parse billing import", () => {
    const rows = [
      { "国际运单号": "T1", "运费(RUB)": "500", "Ozon订单号": "P001" },
      { "国际运单号": "T2", "运费(RUB)": "300" },
    ];

    const result = adapter.parseBillingImport(rows);
    expect(result.length).toBe(2);
    expect(result[0]!.trackingNumber).toBe("T1");
    expect(result[0]!.costRub).toBe(500);
    expect(result[0]!.postingNumber).toBe("P001");
    expect(result[1]!.costRub).toBe(300);
  });

  it("should have correct adapter name", () => {
    expect(adapter.name).toBe("kuajingbus");
  });
});

describe("TransitionLogisticsService", () => {
  let service: TransitionLogisticsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TransitionLogisticsService(mockDb as never);
  });

  describe("generateExport", () => {
    it("should query pending orders and return formatted export", async () => {
      mockDb.all = vi.fn()
        .mockResolvedValueOnce([
          {
            posting_number: "P123", order_number: "ONZ-1",
            buyer_name: "Ivan", buyer_phone: "+7999",
            products_json: '[{"sku":12345,"name":"Phone Case","quantity":1}]',
            total_price_rub: 1500, total_cost_cny: 80,
            logistics_tracking: "SF123", payment_status: "paid",
          },
        ])
        .mockResolvedValueOnce([{ weight_kg: 0.5 }]);

      const result = await service.generateExport();

      expect(result.rows.length).toBe(1);
      expect(result.rows[0]!["Ozon订单号"]).toBe("P123");
      expect(result.headers).toContain("Ozon订单号");
    });
  });

  describe("importTracking", () => {
    it("should import tracking and backfill Ozon successfully", async () => {
      const rows = [{ "Ozon订单号": "P001", "国际运单号": "CDEK-123", "物流商": "cdek" }];

      // Mock DB: order found
      mockDb.all = vi.fn()
        .mockResolvedValueOnce([{ posting_number: "P001", products_json: '[{"sku":1,"quantity":2}]', id: "o1" }]);

      const result = await service.importTracking(rows, mockOzonClient as never);

      expect(result.total).toBe(1);
      expect(result.succeeded.length).toBe(1);
      expect(result.succeeded[0]!.postingNumber).toBe("P001");
      expect(result.succeeded[0]!.trackingNumber).toBe("CDEK-123");
      expect(result.failed.length).toBe(0);
    });

    it("should fail for orders not found in DB", async () => {
      const rows = [{ "Ozon订单号": "P999", "国际运单号": "CDEK-999" }];
      mockDb.all = vi.fn().mockResolvedValueOnce([]);

      const result = await service.importTracking(rows, mockOzonClient as never);

      expect(result.total).toBe(1);
      expect(result.succeeded.length).toBe(0);
      expect(result.failed.length).toBe(1);
      expect(result.failed[0]!.error).toBe("订单不存在");
    });

    it("should send TG alert on import failures", async () => {
      const rows = [
        { "Ozon订单号": "P001", "国际运单号": "T1" },
        { "Ozon订单号": "P002", "国际运单号": "T2" },
      ];
      mockDb.all = vi.fn()
        .mockResolvedValueOnce([]) // P001 not found
        .mockResolvedValueOnce([]); // P002 not found

      const result = await service.importTracking(rows, mockOzonClient as never);

      expect(result.failed.length).toBe(2);
      expect(mockNotifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "error",
          event: "TRANSITION_IMPORT_FAILED",
        })
      );
    });
  });

  describe("importBilling", () => {
    it("should match by posting_number and write cost", async () => {
      const rows = [
        { "Ozon订单号": "P001", "国际运单号": "T1", "运费(RUB)": "500" },
        { "国际运单号": "T2", "运费(RUB)": "300" }, // unmatched
      ];

      mockDb.all = vi.fn()
        .mockResolvedValueOnce([{ posting_number: "P001", total_price_rub: 3000, total_cost_cny: 150 }])
        .mockResolvedValueOnce([]); // second row: tracking match not found

      const result = await service.importBilling(rows);

      expect(result.total).toBe(2);
      expect(result.matched).toBe(1);
      expect(result.unmatched.length).toBe(1);
      expect(result.profitBySku.length).toBe(1);
      expect(result.profitBySku[0]!.logisticsCostRub).toBe(500);
    });
  });

  describe("getDashboard", () => {
    it("should return all dashboard counts", async () => {
      mockDb.all = vi.fn()
        .mockResolvedValueOnce([{ cnt: 10 }])  // pendingExport
        .mockResolvedValueOnce([{ cnt: 5 }])   // pendingImport
        .mockResolvedValueOnce([{ cnt: 3 }])   // pendingBilling
        .mockResolvedValueOnce([{ cnt: 2 }])   // overdue24h
        .mockResolvedValueOnce([{ cnt: 1 }]);  // overdue48h

      const dashboard = await service.getDashboard();

      expect(dashboard.pendingExport).toBe(10);
      expect(dashboard.pendingImport).toBe(5);
      expect(dashboard.pendingBilling).toBe(3);
      expect(dashboard.overdue24h).toBe(2);
      expect(dashboard.overdue48h).toBe(1);
    });
  });

  describe("check24hOverdue", () => {
    it("should send TG alert for overdue orders", async () => {
      const oldDate = new Date(Date.now() - 30 * 3600_000).toISOString();
      mockDb.all = vi.fn().mockResolvedValueOnce([
        { posting_number: "P1", total_amount_cny: 800, pay_time: oldDate },
        { posting_number: "P2", total_amount_cny: 1200, pay_time: oldDate },
      ]);

      const count = await service.check24hOverdue();

      expect(count).toBe(2);
      expect(mockNotifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "warn",
          event: "TRANSITION_24H_OVERDUE",
          force: true,
        })
      );
    });

    it("should return 0 when no overdue orders", async () => {
      mockDb.all = vi.fn().mockResolvedValueOnce([]);
      const count = await service.check24hOverdue();
      expect(count).toBe(0);
      expect(mockNotifier.notify).not.toHaveBeenCalled();
    });
  });

  describe("check48hOverdue", () => {
    it("should send critical TG alert for 48h+ overdue", async () => {
      const oldDate = new Date(Date.now() - 55 * 3600_000).toISOString();
      mockDb.all = vi.fn().mockResolvedValueOnce([
        { posting_number: "P5", total_amount_cny: 2000, pay_time: oldDate },
      ]);

      const count = await service.check48hOverdue();
      expect(count).toBe(1);
      expect(mockNotifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "critical",
          event: "TRANSITION_48H_OVERDUE",
        })
      );
    });
  });
});
