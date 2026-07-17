// ============================================================
// Purchase Pay Orchestrator — lock → risk → pay → logistics
// Handles: primary channel, fallback channels, retry, notification
// ============================================================

import type { DbAdapter } from "../db/connection.js";
import { logger } from "@onzo/logger";
import { randomUUID } from "node:crypto";
import { cache } from "@onzo/cache";
import { acquireLock, releaseLock } from "./redis-lock.js";
import { runRiskCheck } from "./purchase-risk.js";
import {
  checkSigningStatus,
  autoDebit,
  createPurchaseOrder,
  type AutoDebitResult,
  AlibabaApiError,
} from "./alibaba-openplatform.js";
import { emitEvent, EVENT_KEYS } from "./notification-events.js";

// Playwright fallback when 1688 Open Platform API is unavailable
let _playwrightPurchase: typeof import("./playwright-purchase.js").playwrightPurchase | null = null;
async function getPlaywrightPurchase() {
  if (!_playwrightPurchase) {
    try {
      _playwrightPurchase = (await import("./playwright-purchase.js")).playwrightPurchase;
    } catch { /* playwright may not be installed */ }
  }
  return _playwrightPurchase;
}

// ---- Types ----

export interface PayOrderInput {
  storeId: string;
  ozonPostingNumber: string;
  ozonOrderId: number;
  costCny: number;
  sellingPriceRub: number;
  weightKg: number;
  source1688Url?: string;
  skuList: Array<{ sku: number; quantity: number; unitPriceCny: number }>;
  offerId?: string;
}

export interface PayResult {
  success: boolean;
  purchaseId: string;
  paySerial?: string;
  channel: string;
  errorCode?: string;
  errorMsg?: string;
  fallbackUsed: boolean;
}

export interface PurchaseBill {
  date: string;
  totalCny: number;
  count: number;
  orders: Array<{
    id: string;
    postingNumber: string;
    amountCny: number;
    channel: string;
    payTime: string;
  }>;
}

// ---- Config ----

const FALLBACK_BUYER_IDS: Record<string, string> = {
  alipay_deduct: process.env.ALIBABA_DEDUCT_BUYER_ID || "mock_deduct_buyer",
  chengyishe: process.env.CHENGYISHE_BUYER_ID || "mock_chengyishe_buyer",
  kuajingbao: process.env.KUAJINGBAO_BUYER_ID || "mock_kuajingbao_buyer",
};

const CHANNEL_ORDER = ["alipay_deduct", "chengyishe", "kuajingbao"] as const;

// ---- Main Service ----

export class PurchasePayService {
  constructor(private db: DbAdapter | null) {}

  /** Pay for an Ozon order via 1688 — full orchestration. */
  async payOrder(input: PayOrderInput): Promise<PayResult> {
    const lockKey = `purchase:pay:${input.ozonPostingNumber}`;
    const lockToken = await acquireLock(lockKey, 120);
    if (!lockToken) {
      return { success: false, purchaseId: "", channel: "", errorCode: "LOCKED", errorMsg: "Payment in progress — duplicate request blocked", fallbackUsed: false };
    }

    try {
      return await this._payInternal(input);
    } finally {
      await releaseLock(lockKey, lockToken);
    }
  }

  private async _payInternal(input: PayOrderInput): Promise<PayResult> {
    // 1. Check for existing paid order
    if (this.db) {
      const existing = await this.db.all<{ id: string; payment_status: string }>(
        "SELECT id, payment_status FROM purchase_1688 WHERE ozon_posting_number = ? AND store_id = ?",
        [input.ozonPostingNumber, input.storeId]
      );
      if (existing.length > 0 && existing[0].payment_status === "paid") {
        return { success: false, purchaseId: existing[0].id, channel: "", errorCode: "ALREADY_PAID", errorMsg: "Order already paid", fallbackUsed: false };
      }
    }

    // 2. Risk check
    const risk = await runRiskCheck({
      storeId: input.storeId,
      ozonPostingNumber: input.ozonPostingNumber,
      costCny: input.costCny,
      sellingPriceRub: input.sellingPriceRub,
      weightKg: input.weightKg,
      source1688Url: input.source1688Url,
    }, this.db);

    if (!risk.passed) {
      await emitEvent(EVENT_KEYS.PURCHASE_RISK_BLOCKED, {
        postingNumber: input.ozonPostingNumber,
        reason: risk.blockReason || "风控拦截",
      });
      await this.upsertPurchase(input, "failed", undefined, risk);
      return { success: false, purchaseId: "", channel: "", errorCode: "RISK_BLOCKED", errorMsg: risk.blockReason, fallbackUsed: false };
    }

    // 3. Try channels in order (primary → fallback → last resort)
    let lastError: AutoDebitResult | null = null;
    let usedFallback = false;

    for (const channel of CHANNEL_ORDER) {
      const buyerId = FALLBACK_BUYER_IDS[channel];
      if (!buyerId) continue;

      // Check signing status
      const signing = await checkSigningStatus(buyerId);
      if (!signing.signed) {
        logger.info({ channel, buyerId }, "PurchasePay: Channel not signed, skipping");
        continue;
      }

      if (channel !== "alipay_deduct") usedFallback = true;

      const result = await autoDebit({
        buyerId,
        orderId: `OZON-${input.ozonPostingNumber}`,
        amountCny: input.costCny,
        subject: `ONZO采购-${input.ozonPostingNumber}-${input.skuList.map((s) => s.sku).join(",")}`,
      });

      if (result.success) {
        await this.upsertPurchase(input, "paid", result, risk);
        await emitEvent(EVENT_KEYS.PURCHASE_PAY_SUCCESS, {
          postingNumber: input.ozonPostingNumber,
          amountCny: String(input.costCny),
          channel,
        });
        logger.info({ postingNumber: input.ozonPostingNumber, channel, paySerial: result.paySerial }, "PurchasePay: Payment successful");
        return { success: true, purchaseId: result.paySerial, paySerial: result.paySerial, channel, fallbackUsed: usedFallback };
      }

      lastError = result;

      // Alert on critical errors (IP whitelist, permission, balance)
      if (result.errorCode) {
        const lower = result.errorCode.toLowerCase();
        if (lower.includes("ip") || lower.includes("whitelist")) {
          await emitEvent(EVENT_KEYS.ALIBABA_IP_BLOCKED, {
            channel,
            error: result.errorMsg || "IP白名单拦截",
            postingNumber: input.ozonPostingNumber,
          });
        } else if (lower.includes("401") || lower.includes("token") || lower.includes("expired") || lower.includes("permission")) {
          await emitEvent(EVENT_KEYS.ALIBABA_AUTH_EXPIRED, {
            channel,
            error: result.errorMsg || "Token/权限过期",
          });
        } else if (lower.includes("balance") || lower.includes("insufficient")) {
          await emitEvent(EVENT_KEYS.ALIBABA_BALANCE_LOW, {
            channel,
            error: result.errorMsg || "余额不足",
            postingNumber: input.ozonPostingNumber,
          });
        }
      }

      logger.warn({ postingNumber: input.ozonPostingNumber, channel, errorCode: result.errorCode }, "PurchasePay: Channel failed, trying next");
    }

    // 4. All channels exhausted — failure
    const finalError = lastError || { success: false, paySerial: "", errorCode: "ALL_CHANNELS_FAILED", errorMsg: "所有支付渠道均不可用" };
    await this.upsertPurchase(input, "failed", {
      success: false,
      paySerial: "",
      errorCode: finalError.errorCode,
      errorMsg: finalError.errorMsg,
    }, risk);
    await emitEvent(EVENT_KEYS.PURCHASE_PAY_FAILED, {
      postingNumber: input.ozonPostingNumber,
      error: finalError.errorMsg || "支付失败",
      channel: "all",
    });

    return { success: false, purchaseId: "", paySerial: undefined, channel: "", errorCode: finalError.errorCode, errorMsg: finalError.errorMsg, fallbackUsed: usedFallback };
  }

  /** Create a 1688 purchase order (API first, Playwright fallback). */
  async createOrder(input: PayOrderInput): Promise<{ success: boolean; orderId?: string; error?: string; method: "api" | "playwright" | "none" }> {
    // Try API first
    const buyerId = FALLBACK_BUYER_IDS["alipay_deduct"];
    if (buyerId && input.offerId) {
      try {
        const result = await createPurchaseOrder({
          buyerId, offerId: input.offerId,
          quantity: input.skuList.reduce((sum, s) => sum + s.quantity, 0),
          unitPriceCny: input.skuList[0]?.unitPriceCny || input.costCny,
          subject: `ONZO-${input.ozonPostingNumber}`,
          storeId: input.storeId,
        });
        if (result.success && result.orderId) {
          await this.upsertPurchase(input, "pending", { success: true, paySerial: result.orderId, tradeNo: result.orderId }, undefined);
          logger.info({ orderId: result.orderId, postingNumber: input.ozonPostingNumber }, "PurchasePay: Order created via API");
          return { success: true, orderId: result.orderId, method: "api" };
        }
        logger.warn({ error: result.errorMsg }, "PurchasePay: API order failed, trying Playwright fallback");
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "PurchasePay: API unavailable, trying Playwright fallback");
      }
    }

    // Playwright fallback
    if (input.source1688Url) {
      const pwPurchase = await getPlaywrightPurchase();
      if (pwPurchase) {
        try {
          const result = await pwPurchase({
            offerUrl: input.source1688Url,
            quantity: input.skuList.reduce((sum, s) => sum + s.quantity, 0),
            maxCostCny: input.costCny,
          });
          if (result.success && result.orderId) {
            await this.upsertPurchase(input, "pending", {
              success: true, paySerial: result.orderId, tradeNo: result.orderId,
            }, undefined);
            logger.info({ orderId: result.orderId, postingNumber: input.ozonPostingNumber }, "PurchasePay: Order created via Playwright");
            return { success: true, orderId: result.orderId, method: "playwright" };
          }
          return { success: false, error: result.errorMsg || "Playwright purchase failed", method: "playwright" };
        } catch (err) {
          logger.error({ err: (err as Error).message }, "PurchasePay: Playwright purchase error");
          return { success: false, error: (err as Error).message, method: "none" };
        }
      }
    }

    return { success: false, error: "No 1688 offer URL and API unavailable", method: "none" };
  }

  /**
   * Auto-purchase from Ozon order: reads SKU-1688 mapping → creates 1688 purchase with freight address.
   * This is the main automation entry point called after Ozon order sync.
   */
  async autoPurchaseFromOzonOrder(ozonPostingNumber: string, storeId = "store_1"): Promise<PayResult & { queued?: boolean }> {
    if (!this.db) return { success: false, purchaseId: "", channel: "", errorCode: "DB_UNAVAILABLE", errorMsg: "Database unavailable", fallbackUsed: false };

    // 1. Check rate-limit queue (anti-fraud: max N orders/minute per store)
    const queueKey = `purchase:rate:${storeId}`;
    const rateCount = await cache.counterIncr("purchase", `rate:${storeId}`, 60);
    const maxRpm = parseInt(process.env.PURCHASE_MAX_RPM || "5", 10);
    if (rateCount > maxRpm) {
      // Queue the order for delayed processing
      const { enqueueDelayTask } = await import("./redis-delay-queue.js");
      await enqueueDelayTask({
        id: `purchase_${ozonPostingNumber}`,
        type: "ozon_import_check",
        payload: { postingNumber: ozonPostingNumber, storeId },
        executeAt: Date.now() + 60_000, // delay 1 minute
      });
      await emitEvent("PURCHASE_QUEUED" as never, {
        postingNumber: ozonPostingNumber,
        reason: `频率限制 ${rateCount}/${maxRpm} rpm`,
      } as never);
      logger.info({ ozonPostingNumber, storeId, rateCount }, "PurchasePay: rate-limited, queued");
      return { success: false, purchaseId: "", channel: "", errorCode: "RATE_LIMITED_QUEUED", errorMsg: `Rate limited (${rateCount}/${maxRpm} rpm), queued for delayed processing`, fallbackUsed: false, queued: true };
    }

    // 2. Read Ozon order from ozon_orders table
    const ozonRows = await this.db.all<Record<string, unknown>>(
      "SELECT * FROM ozon_orders WHERE posting_number = ? AND store_id = ?",
      [ozonPostingNumber, storeId]
    );
    if (ozonRows.length === 0) return { success: false, purchaseId: "", channel: "", errorCode: "ORDER_NOT_FOUND", errorMsg: "Ozon order not found in database", fallbackUsed: false };

    const ozonOrder = ozonRows[0];
    const products = JSON.parse((ozonOrder.products_json as string) || "[]") as Array<{ sku: number; offerId: string; name: string; quantity: number; price: number; source1688Url?: string; costCny?: number }>;

    // 3. For each product SKU, lookup SKU-1688 mapping
    const { SkuMappingService } = await import("./sku-mapping.js");
    const skuService = new SkuMappingService(this.db);

    const skuList: Array<{ sku: number; quantity: number; unitPriceCny: number }> = [];
    let totalCostCny = 0;
    let freightAddress = "";
    let source1688Url = "";
    let allMapped = true;

    for (const product of products) {
      const mapping = await skuService.lookup(storeId, product.offerId, product.sku);
      if (mapping) {
        skuList.push({ sku: product.sku, quantity: product.quantity, unitPriceCny: mapping.purchasePriceCny });
        totalCostCny += mapping.purchasePriceCny * product.quantity;
        freightAddress = freightAddress || mapping.freightAddress;
        source1688Url = source1688Url || mapping.source1688Url;
      } else {
        allMapped = false;
        // Fallback: use product's own costCny and sourceUrl
        if (product.costCny) {
          skuList.push({ sku: product.sku, quantity: product.quantity, unitPriceCny: product.costCny });
          totalCostCny += product.costCny * product.quantity;
        }
        source1688Url = source1688Url || product.source1688Url || "";
      }
    }

    if (skuList.length === 0) {
      return { success: false, purchaseId: "", channel: "", errorCode: "NO_SKU_MAPPING", errorMsg: "No SKU-1688 mapping found and no cost data available", fallbackUsed: false };
    }

    if (!allMapped) {
      logger.warn({ ozonPostingNumber, mappedCount: products.length - skuList.length + (allMapped ? 0 : 1) }, "PurchasePay: Partial SKU mapping — some products have no 1688 source");
    }

    // 4. Build PayOrderInput from enriched data
    const input: PayOrderInput = {
      storeId,
      ozonPostingNumber,
      ozonOrderId: ozonOrder.order_id as number,
      costCny: totalCostCny,
      sellingPriceRub: ozonOrder.total_price_rub as number || 0,
      weightKg: 0.5,
      source1688Url: source1688Url || (ozonOrder.source_1688_url as string) || undefined,
      skuList,
      offerId: products[0]?.offerId || undefined,
    };

    // 5. Check SKU mapping profit before paying
    for (const product of products) {
      const profitCheck = await skuService.checkProfit(storeId, product.offerId, product.sku, product.price);
      if (profitCheck && !profitCheck.passed) {
        logger.warn({ ozonPostingNumber, sku: product.sku, margin: profitCheck.marginPercent }, "PurchasePay: profit below threshold, blocking auto-purchase");
        await emitEvent(EVENT_KEYS.PURCHASE_RISK_BLOCKED, {
          postingNumber: ozonPostingNumber,
          reason: `SKU ${product.sku} 利润率 ${profitCheck.marginPercent}% < 10% 阈值`,
        });
        await this.upsertPurchase(input, "failed", { success: false, paySerial: "", errorCode: "LOW_PROFIT", errorMsg: `Profit margin ${profitCheck.marginPercent}% below threshold` }, undefined);
        return { success: false, purchaseId: "", channel: "", errorCode: "LOW_PROFIT", errorMsg: `Profit margin below threshold`, fallbackUsed: false };
      }
    }

    // 6. Proceed with payment
    logger.info({ ozonPostingNumber, skuCount: skuList.length, totalCostCny, freightAddress }, "PurchasePay: Auto-purchase from Ozon order");
    return this.payOrder(input);
  }

  /** Retry a previously failed payment. */
  async retryFailedPayment(purchaseId: string, input: PayOrderInput): Promise<PayResult> {
    if (this.db) {
      await this.db.run(
        "UPDATE purchase_1688 SET payment_status = 'paying', retry_count = retry_count + 1, updated_at = datetime('now') WHERE id = ?",
        [purchaseId]
      );
    }
    return this.payOrder(input);
  }

  /** Get daily purchase bill for finance reconciliation. */
  async getDailyBill(date: string): Promise<PurchaseBill> {
    if (!this.db) return { date, totalCny: 0, count: 0, orders: [] };

    const rows = await this.db.all<{
      id: string; posting_number: string; total_amount_cny: number;
      pay_channel: string; pay_time: string;
    }>(
      `SELECT id, ozon_posting_number as posting_number, total_amount_cny,
              pay_channel, pay_time
       FROM purchase_1688
       WHERE payment_status = 'paid' AND pay_time LIKE ?
       ORDER BY pay_time DESC`,
      [`${date}%`]
    );

    const totalCny = rows.reduce((sum, r) => sum + r.total_amount_cny, 0);
    return {
      date,
      totalCny: Math.round(totalCny * 100) / 100,
      count: rows.length,
      orders: rows.map((r) => ({
        id: r.id,
        postingNumber: r.posting_number,
        amountCny: r.total_amount_cny,
        channel: r.pay_channel,
        payTime: r.pay_time,
      })),
    };
  }

  /** Insert or update purchase_1688 record. */
  private async upsertPurchase(
    input: PayOrderInput,
    status: string,
    payResult: AutoDebitResult | undefined,
    risk: { passed: boolean; checks: Record<string, boolean>; blockReason?: string } | undefined,
  ): Promise<void> {
    if (!this.db) return;

    const id = randomUUID();
    const now = new Date().toISOString();

    await this.db.run(
      `INSERT INTO purchase_1688 (id, store_id, ozon_posting_number, ozon_order_id,
        source_1688_url, offer_id, sku_list_json, total_amount_cny,
        payment_status, pay_serial, pay_time, pay_channel, pay_error,
        risk_check_json, retry_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(store_id, ozon_posting_number) DO UPDATE SET
        payment_status = EXCLUDED.payment_status,
        pay_serial = EXCLUDED.pay_serial, pay_time = EXCLUDED.pay_time,
        pay_channel = EXCLUDED.pay_channel, pay_error = EXCLUDED.pay_error,
        risk_check_json = EXCLUDED.risk_check_json,
        retry_count = purchase_1688.retry_count + 1,
        updated_at = EXCLUDED.updated_at`,
      [
        id, input.storeId, input.ozonPostingNumber, input.ozonOrderId,
        input.source1688Url || null, input.offerId || null,
        JSON.stringify(input.skuList), input.costCny,
        status,
        payResult?.paySerial || null,
        payResult?.success ? now : null,
        payResult?.success ? (payResult.paySerial?.startsWith("PAY-") ? "alipay_deduct" : "unknown") : null,
        payResult?.errorMsg || risk?.blockReason || null,
        JSON.stringify(risk?.checks || {}),
        now, now,
      ]
    );
  }
}