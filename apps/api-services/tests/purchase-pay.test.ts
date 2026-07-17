// ============================================================
// Purchase Pay Tests — 4 core scenarios
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock 1688 alibaba openplatform SDK
vi.mock("../src/services/alibaba-openplatform.js", () => ({
  checkSigningStatus: vi.fn(),
  autoDebit: vi.fn(),
  queryPaymentResult: vi.fn(),
  createPurchaseOrder: vi.fn(),
  queryOrder: vi.fn(),
  getLogisticsTrace: vi.fn(),
  AlibabaApiError: class extends Error {
    constructor(public errorCode: string, message: string, public category: string) { super(message); }
  },
}));

// Mock Redis lock
vi.mock("../src/services/redis-lock.js", () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
}));

// Mock notification events
vi.mock("../src/services/notification-events.js", () => ({
  emitEvent: vi.fn(),
  EVENT_KEYS: {
    PURCHASE_PAY_SUCCESS: "PURCHASE_PAY_SUCCESS",
    PURCHASE_PAY_FAILED: "PURCHASE_PAY_FAILED",
    PURCHASE_RISK_BLOCKED: "PURCHASE_RISK_BLOCKED",
  },
}));

// Mock exchange rate
vi.mock("../src/services/exchange-rate.js", () => ({
  getExchangeRate: vi.fn().mockResolvedValue({ rate: 11.5, cached: true, stale: false, reliable: true, source: "test" }),
}));

import { PurchasePayService } from "../src/services/purchase-pay.js";
import { checkSigningStatus, autoDebit } from "../src/services/alibaba-openplatform.js";
import { acquireLock, releaseLock } from "../src/services/redis-lock.js";

function makeInput() {
  return {
    storeId: "store_1",
    ozonPostingNumber: "TEST-POST-001",
    ozonOrderId: 12345,
    costCny: 500,
    sellingPriceRub: 8000,
    weightKg: 0.5,
    source1688Url: "https://detail.1688.com/offer/test.html",
    skuList: [{ sku: 1001, quantity: 2, unitPriceCny: 250 }],
  };
}

describe("PurchasePayService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkSigningStatus).mockResolvedValue({ signed: true, channel: "alipay_deduct" });
    vi.mocked(autoDebit).mockResolvedValue({ success: true, paySerial: "PAY-MOCK-001", tradeNo: "TRADE-001" });
    vi.mocked(acquireLock).mockResolvedValue(true);
    vi.mocked(releaseLock).mockResolvedValue(undefined);
  });

  it("pays successfully and returns paySerial", async () => {
    const service = new PurchasePayService(null);
    const result = await service.payOrder(makeInput());
    expect(result.success).toBe(true);
    expect(result.paySerial).toBe("PAY-MOCK-001");
    expect(result.channel).toBe("alipay_deduct");
    expect(acquireLock).toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalled();
  });

  it("blocks on insufficient balance (mock alipay failure)", async () => {
    vi.mocked(autoDebit).mockResolvedValue({
      success: false, paySerial: "PAY-FAIL-001",
      errorCode: "INSUFFICIENT_BALANCE", errorMsg: "账户余额不足",
    });

    const service = new PurchasePayService(null);
    const result = await service.payOrder(makeInput());
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("INSUFFICIENT_BALANCE");
  });

  it("prevents duplicate payment via Redis lock", async () => {
    vi.mocked(acquireLock).mockResolvedValue(false); // lock held by another process

    const service = new PurchasePayService(null);
    const result = await service.payOrder(makeInput());
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("LOCKED");
    // autoDebit should NOT be called
    expect(autoDebit).not.toHaveBeenCalled();
  });

  it("blocks on risk check (profit margin < 10%)", async () => {
    // Cost is 95% of selling price — margin only 5%, below 10% threshold
    const input = { ...makeInput(), costCny: 6840 / 11.5, sellingPriceRub: 8000 };
    const service = new PurchasePayService(null);
    const result = await service.payOrder(input);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("RISK_BLOCKED");
    expect(autoDebit).not.toHaveBeenCalled();
  });

  it("handles fallback channel when primary not signed", async () => {
    // Primary not signed, chengyishe fails, kuajingbao succeeds
    vi.mocked(checkSigningStatus)
      .mockResolvedValueOnce({ signed: false, channel: "alipay_deduct" })   // primary
      .mockResolvedValueOnce({ signed: false, channel: "chengyishe" })      // fallback 1
      .mockResolvedValueOnce({ signed: true, channel: "kuajingbao" });      // fallback 2

    vi.mocked(autoDebit).mockResolvedValue({ success: true, paySerial: "PAY-FALLBACK-001", tradeNo: "TRADE-FB" });

    const service = new PurchasePayService(null);
    const result = await service.payOrder(makeInput());
    expect(result.success).toBe(true);
    expect(result.channel).toBe("kuajingbao");
    expect(result.fallbackUsed).toBe(true);
  });

  it("retryFailedPayment resets status and pays again", async () => {
    const service = new PurchasePayService(null);
    const result = await service.retryFailedPayment("purchase-id-1", makeInput());
    expect(result.success).toBe(true);
  });
});