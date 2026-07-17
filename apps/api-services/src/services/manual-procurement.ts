// ============================================================
// Manual Procurement Service — MANUAL_PAY_MODE
//
// Flow:
//   1. Sync Ozon orders (awaiting_delivery) → match SKU to 1688
//   2. Profit check: price - purchase_cost - est_logistics < threshold → block
//   3. Create 1688 purchase order (NO auto-pay, stays pending)
//   4. TG notification with payment instructions
//   5. 24h unpaid reminder job → re-notify
//   6. 1688 callback + polling: sync payment/shipping status
//
// Switch: MANUAL_PAY_MODE=true (manual) / false (auto-pay via alipay_deduct)
// ============================================================

import type { DbAdapter } from "../db/connection.js";
import { serializedWrite } from "../db/connection.js";
import { logger } from "@onzo/logger";
import { notifier } from "./notifier.js";
import { acquireLock, releaseLock } from "./redis-lock.js";
import { FREIGHT_ADDRESS } from "../config/freight-address.js";
import { createPurchaseOrder as create1688Order } from "./alibaba-openplatform.js";

// ---- Types ----

export interface OzonOrderForProcurement {
  postingNumber: string;
  orderId: number;
  status: string;
  products: Array<{ sku: number; offerId: string; name: string; quantity: number; priceRub: number }>;
  totalPriceRub: number;
  shipmentDeadline?: string;
}

export interface SkuMatchResult {
  sku: number;
  ozonOfferId: string;
  source1688Url: string;
  offer1688Id?: string;
  sku1688Id?: string;
  purchasePriceCny: number;
  weightKg: number;
  freightAddress: string;
  supplierName: string;
  supplierPickupRate: number;  // 0-1, e.g. 0.92 = 92% 24h揽收率
  matched: boolean;
}

export interface ProfitCheckResult {
  passed: boolean;
  postingNumber: string;
  priceRub: number;
  purchaseCostCny: number;
  estimatedLogisticsRub: number;
  estimatedProfitRub: number;
  marginPercent: number;
  threshold: number;
  reason?: string;
}

export interface PurchaseOrderResult {
  success: boolean;
  postingNumber: string;
  purchaseId?: string;
  alibabaOrderId?: string;
  totalAmountCny: number;
  paymentStatus: string;
  error?: string;
  needsManualPayment: boolean;
}

export interface PurchaseBatchResult {
  total: number;
  matched: number;
  profitBlocked: number;
  created: number;
  failed: number;
  skipped: number;
  results: PurchaseOrderResult[];
}

// ---- Service ----

export class ManualProcurementService {
  constructor(private db: DbAdapter | null) {}

  get enabled(): boolean {
    return process.env.MANUAL_PAY_MODE === "true";
  }

  // ==============================================================
  // 1. Ozon Order Sync + SKU Match
  // ==============================================================

  /**
   * Sync awaiting_delivery orders from Ozon and match to 1688 SKU mapping.
   * Called by scheduled job and manual trigger.
   */
  async syncAndMatch(ozonClient: unknown): Promise<{
    orders: OzonOrderForProcurement[];
    matched: Array<{ order: OzonOrderForProcurement; skuMatches: SkuMatchResult[] }>;
  }> {
    if (!this.db) return { orders: [], matched: [] };

    // Get awaiting_delivery orders from local_orders
    const orders = await this.db.all<{
      posting_number: string; order_id: number; status: string;
      total_price_rub: number; raw_json: string;
    }>(
      `SELECT posting_number, order_id, status, total_price_rub, raw_json
       FROM local_orders
       WHERE status = 'awaiting_deliver' OR status = 'awaiting_delivery'
       ORDER BY created_at DESC
       LIMIT 200`
    );

    const procurementOrders: OzonOrderForProcurement[] = [];
    const matchedResults: Array<{ order: OzonOrderForProcurement; skuMatches: SkuMatchResult[] }> = [];

    for (const o of orders) {
      let products: Array<{ sku: number; offerId: string; name: string; quantity: number; priceRub: number }> = [];
      try {
        const raw = JSON.parse(o.raw_json || "{}");
        // products_json may be a string (from Ozon API) or already parsed array (from local_orders)
        let prods: unknown[] = [];
        const prodData = raw.products || raw.products_json || raw.items;
        if (typeof prodData === "string") {
          prods = JSON.parse(prodData);
        } else if (Array.isArray(prodData)) {
          prods = prodData;
        } else if (prodData && typeof prodData === "object") {
          prods = [prodData];
        }
        products = (prods as Array<Record<string, unknown>>).map((r) => ({
          sku: Number(r.sku || r.product_id || 0),
          offerId: String(r.offer_id || r.offerId || ""),
          name: String(r.name || r.title || ""),
          quantity: Number(r.quantity || 1),
          priceRub: Number(r.price || r.total_price || 0),
        }));
      } catch {
        products = [{ sku: 0, offerId: "", name: "", quantity: 1, priceRub: o.total_price_rub }];
      }

      const order: OzonOrderForProcurement = {
        postingNumber: o.posting_number,
        orderId: o.order_id,
        status: o.status,
        products,
        totalPriceRub: o.total_price_rub,
      };
      procurementOrders.push(order);

      // Match each SKU to 1688
      const skuMatches: SkuMatchResult[] = [];
      for (const p of products) {
        const match = await this.matchSku(p.sku, p.offerId);
        skuMatches.push(match);
      }
      matchedResults.push({ order, skuMatches });
    }

    logger.info({ orderCount: procurementOrders.length }, "ManualProcurement: order sync complete");
    return { orders: procurementOrders, matched: matchedResults };
  }

  /** Match a single SKU to 1688 product */
  private async matchSku(sku: number, offerId: string): Promise<SkuMatchResult> {
    const empty = {
      sku, ozonOfferId: offerId, source1688Url: "", purchasePriceCny: 0,
      weightKg: 0.3, freightAddress: FREIGHT_ADDRESS,
      supplierName: "", supplierPickupRate: 0,
      matched: false,
    };
    if (!this.db) return empty;

    interface SkuRow {
      source_1688_url: string; offer_1688_id: string; sku_1688_id: string;
      purchase_price_cny: number; weight_kg: number; freight_address: string;
      supplier_name: string; supplier_pickup_rate: number;
    }
    const rows = await this.db.all<SkuRow>(
      `SELECT source_1688_url, offer_1688_id, sku_1688_id,
              purchase_price_cny, weight_kg, freight_address,
              COALESCE(supplier_name, '') AS supplier_name,
              COALESCE(supplier_pickup_rate, 0) AS supplier_pickup_rate
       FROM sku_1688_mapping
       WHERE (ozon_offer_id = ? OR ozon_sku = ?)
       LIMIT 1`,
      [offerId, sku]
    ).catch((): SkuRow[] => []);

    if (rows.length === 0) return empty;

    const r = rows[0]!;
    return {
      sku, ozonOfferId: offerId,
      source1688Url: r.source_1688_url,
      offer1688Id: r.offer_1688_id || undefined,
      sku1688Id: r.sku_1688_id || undefined,
      purchasePriceCny: r.purchase_price_cny,
      weightKg: r.weight_kg,
      freightAddress: r.freight_address || FREIGHT_ADDRESS,
      supplierName: r.supplier_name,
      supplierPickupRate: r.supplier_pickup_rate,
      matched: true,
    };
  }

  // ==============================================================
  // 2. Profit Validation
  // ==============================================================

  /**
   * Check if an order is profitable enough to proceed with purchase.
   * Threshold: MANUAL_PROFIT_THRESHOLD_MARGIN (default 0.10 = 10% margin minimum)
   */
  async checkProfit(
    order: OzonOrderForProcurement,
    skuMatches: SkuMatchResult[],
  ): Promise<ProfitCheckResult> {
    const threshold = parseFloat(process.env.MANUAL_PROFIT_THRESHOLD_MARGIN || "0.10");

    // Sum up all costs
    const totalPurchaseCny = skuMatches.reduce((sum, m) => sum + m.purchasePriceCny * (order.products.find((p) => p.sku === m.sku)?.quantity || 1), 0);
    const totalWeightKg = skuMatches.reduce((sum, m) => sum + m.weightKg, 0);

    // Estimate logistics cost: ~500 RUB/kg average
    const estimatedLogisticsRub = totalWeightKg * 500;

    // Get exchange rate
    let rate = 11.5; // fallback
    try {
      const { getExchangeRate } = await import("./exchange-rate.js");
      const rr = await getExchangeRate();
      rate = rr.rate;
    } catch {}

    const purchaseCostRub = totalPurchaseCny * rate;
    const totalCostRub = purchaseCostRub + estimatedLogisticsRub;
    const estimatedProfitRub = order.totalPriceRub - totalCostRub;
    const marginPercent = order.totalPriceRub > 0 ? estimatedProfitRub / order.totalPriceRub : 0;

    const passed = marginPercent >= threshold;

    const result: ProfitCheckResult = {
      passed,
      postingNumber: order.postingNumber,
      priceRub: order.totalPriceRub,
      purchaseCostCny: totalPurchaseCny,
      estimatedLogisticsRub,
      estimatedProfitRub: Math.round(estimatedProfitRub),
      marginPercent: Math.round(marginPercent * 100) / 100,
      threshold,
    };

    if (!passed) {
      result.reason = `利润率${result.marginPercent}低于阈值${threshold} — 请检查SKU采购价`;
    }

    return result;
  }

  /**
   * Check supplier 24h pickup rate meets minimum threshold.
   * Returns true if blocked (supplier quality too low).
   *
   * Rules:
   *   - rate == 0 (unknown) → warn but ALLOW (don't have data yet)
   *   - rate >= threshold → ALLOW
   *   - rate < threshold → BLOCK + TG critical alert
   */
  checkSupplierQuality(skuMatches: SkuMatchResult[], order: OzonOrderForProcurement): boolean {
    const threshold = parseFloat(process.env.SUPPLIER_MIN_PICKUP_RATE || "0.9");
    const problems: string[] = [];

    for (const m of skuMatches) {
      if (!m.matched) continue;
      if (m.supplierPickupRate === 0) {
        // Unknown — warn but don't block
        logger.warn({
          sku: m.sku, postingNumber: order.postingNumber,
        }, "ManualProcurement: supplier pickup rate unknown for SKU");
        continue;
      }

      if (m.supplierPickupRate < threshold) {
        problems.push(
          `${m.supplierName || "供应商"} 24h揽收率 ${(m.supplierPickupRate * 100).toFixed(0)}% < ${(threshold * 100).toFixed(0)}%`
        );
      }
    }

    if (problems.length === 0) return false; // all good

    // BLOCKED — send critical TG alert
    notifier.notify({
      level: "critical",
      event: "SUPPLIER_QUALITY_BLOCKED",
      message: [
        `🚫 <b>供应商拦截 — 24h揽收率不达标</b>`,
        ``,
        `Ozon订单: <code>${order.postingNumber}</code>`,
        `要求: 24h揽收率 ≥ ${(threshold * 100).toFixed(0)}%`,
        ``,
        ...problems.map((p) => `  ❌ ${p}`),
        ``,
        `<i>请在1688更换揽收率更高的供应商后重试</i>`,
      ].join("\n"),
      correlationId: order.postingNumber,
      force: true,
      metadata: {
        postingNumber: order.postingNumber,
        threshold: String(threshold),
        problems: JSON.stringify(problems),
      },
    }).catch(() => {});

    logger.warn({
      postingNumber: order.postingNumber,
      problems,
      threshold,
    }, "ManualProcurement: supplier quality blocked");

    return true; // blocked
  }

  // ==============================================================
  // 3. Create 1688 Purchase Order (NO auto-pay)
  // ==============================================================

  /**
   * Create a 1688 purchase order WITHOUT paying.
   * In MANUAL_PAY_MODE, the order stays in 'pending_payment' status.
   * User must login to 1688 to complete payment manually.
   */
  async createPurchaseOrder(
    order: OzonOrderForProcurement,
    skuMatches: SkuMatchResult[],
  ): Promise<PurchaseOrderResult> {
    if (!this.db) return { success: false, postingNumber: order.postingNumber, totalAmountCny: 0, paymentStatus: "failed", error: "DB unavailable", needsManualPayment: true };

    const purchaseId = `p_${order.postingNumber}_${Date.now()}`;

    // Calculate total CNY
    const skuList = skuMatches.map((m) => {
      const product = order.products.find((p) => p.sku === m.sku);
      return {
        sku: m.sku,
        quantity: product?.quantity || 1,
        offer1688Id: m.offer1688Id,
        sku1688Id: m.sku1688Id,
        sourceUrl: m.source1688Url,
        priceCny: m.purchasePriceCny,
      };
    });

    const totalAmountCny = skuList.reduce((sum, s) => sum + s.priceCny * s.quantity, 0);

    // Use the freight address from SKU mapping (跨境巴士货代中转仓)
    const freightAddress = skuMatches[0]?.freightAddress
      || FREIGHT_ADDRESS;

    // Redis lock to prevent duplicate purchase creation
    const lockToken = await acquireLock(`purchase:create:${order.postingNumber}`, 120);
    if (!lockToken) {
      return { success: false, postingNumber: order.postingNumber, totalAmountCny, paymentStatus: "skipped", error: "Duplicate: purchase creation in progress", needsManualPayment: true };
    }

    try {
      // Check if purchase already exists
      const existing = await this.db.all<{ id: string }>(
        "SELECT id FROM purchase_1688 WHERE ozon_posting_number = ?",
        [order.postingNumber]
      );
      if (existing.length > 0) {
        return {
          success: false, postingNumber: order.postingNumber,
          totalAmountCny, paymentStatus: "exists",
          purchaseId: existing[0]!.id,
          error: "Purchase order already exists for this posting",
          needsManualPayment: true,
        };
      }

      // Call 1688 API to create a real order (NOT pay — MANUAL_PAY_MODE stops here)
      const buyerId = process.env.ALIBABA_DEDUCT_BUYER_ID || "";
      const firstSku = skuMatches[0];
      const firstOrderProduct = order.products[0];
      const offer1688Id = firstSku?.offer1688Id || firstSku?.sku1688Id || "";

      let alibabaOrderId = "";
      let apiSuccess = false;

      if (buyerId && offer1688Id) {
        // Real 1688 API call
        const apiResult = await create1688Order({
          buyerId,
          offerId: offer1688Id,
          quantity: firstOrderProduct?.quantity || 1,
          unitPriceCny: firstSku?.purchasePriceCny || 0,
          subject: `Ozon ${order.postingNumber} — ${firstOrderProduct?.name || "товар"}`,
        });

        if (apiResult.success && apiResult.orderId) {
          alibabaOrderId = apiResult.orderId;
          apiSuccess = true;
          logger.info({ postingNumber: order.postingNumber, alibabaOrderId, totalAmountCny: apiResult.totalAmountCny }, "ManualProcurement: 1688 order created via API");
        } else {
          logger.error({ postingNumber: order.postingNumber, error: apiResult.errorMsg }, "ManualProcurement: 1688 API create order failed");
          // Continue anyway — write local record so user can retry
        }
      } else if (!buyerId) {
        logger.warn({ postingNumber: order.postingNumber }, "ManualProcurement: ALIBABA_DEDUCT_BUYER_ID not set — 1688 API skipped, local record only");
      } else {
        logger.warn({ postingNumber: order.postingNumber, offer1688Id }, "ManualProcurement: offer1688Id missing — need to set in sku_1688_mapping");
      }

      // Write to local purchase_1688 table
      await serializedWrite(() =>
        this.db!.run(
          `INSERT INTO purchase_1688
           (id, store_id, ozon_posting_number, ozon_order_id, source_1688_url,
            offer_id, sku_list_json, total_amount_cny, payment_status,
            pay_channel, pay_time, alibaba_order_id,
            logistics_status, logistics_tracking, logistics_carrier,
            freight_address, risk_check_json,
            created_at, updated_at)
           VALUES (?, 'store_1', ?, ?, ?, ?, ?, ?, 'pending_payment', 'manual_pay', NULL, ?, 'idle', '', '', ?, ?, datetime('now'), datetime('now'))`,
          [
            purchaseId, order.postingNumber, order.orderId,
            skuList[0]?.sourceUrl || "",
            skuMatches[0]?.ozonOfferId || "",
            JSON.stringify(skuList), totalAmountCny,
            alibabaOrderId,
            freightAddress, JSON.stringify({
              manualPayMode: true,
              needsLogin: true,
              loginUrl: "https://login.1688.com",
              paymentUrl: "https://work.1688.com/home/buyer.htm",
              alibabaOrderId: alibabaOrderId || "(本地记录，未调用API)",
            }),
          ]
        )
      );

      logger.info({ postingNumber: order.postingNumber, purchaseId, totalAmountCny, alibabaOrderId, apiSuccess }, "ManualProcurement: purchase order created (pending manual payment)");

      return {
        success: true,
        postingNumber: order.postingNumber,
        purchaseId,
        totalAmountCny: Math.round(totalAmountCny * 100) / 100,
        paymentStatus: "pending_payment",
        needsManualPayment: true,
      };
    } catch (err) {
      logger.error({ err: (err as Error).message, postingNumber: order.postingNumber }, "ManualProcurement: create purchase failed");
      return { success: false, postingNumber: order.postingNumber, totalAmountCny, paymentStatus: "failed", error: (err as Error).message, needsManualPayment: true };
    } finally {
      await releaseLock(`purchase:create:${order.postingNumber}`, lockToken).catch(() => {});
    }
  }

  // ==============================================================
  // 4. TG Payment Notification
  // ==============================================================

  /**
   * Send TG notification with manual payment instructions.
   */
  async sendPaymentReminder(
    result: PurchaseOrderResult,
    order: OzonOrderForProcurement,
    skuMatches: SkuMatchResult[],
  ): Promise<void> {
    // Build 1688 product URLs for manual verification
    const productLines = order.products.map((p, i) => {
      const m = skuMatches.find((sm) => sm.sku === p.sku);
      const url = m?.source1688Url && !m.source1688Url.includes("manual-input")
        ? m.source1688Url
        : `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(p.name)}`;
      return `  • ${p.name} (SKU ${p.sku}) ×${p.quantity}\n    💰 ¥${m?.purchasePriceCny || "?"}/件 | 🔗 <a href="${url}">1688搜索</a>`;
    });

    const totalCny = skuMatches.reduce((s, m) => s + m.purchasePriceCny, 0);
    const sourceUrls = skuMatches
      .filter((m) => m.source1688Url && !m.source1688Url.includes("manual-input"))
      .map((m) => m.source1688Url);

    const message = [
      `🛒 <b>待支付采购单 — 请验证商品后付款</b>`,
      ``,
      `<b>Ozon订单号:</b> <code>${order.postingNumber}</code>`,
      `<b>采购单编号:</b> <code>${result.purchaseId}</code>`,
      `<b>应付总额:</b> ¥${result.totalAmountCny} CNY`,
      ``,
      `<b>商品明细（请逐一点击验证）:</b>`,
      ...productLines,
      ``,
      sourceUrls.length > 0
        ? `<b>✅ 已验证1688链接:</b>\n${sourceUrls.map((u) => `  🔗 ${u}`).join("\n")}`
        : `<b>⚠️ SKU映射未配置1688链接</b> — 请在1688搜索商品名确认`,
      ``,
      `<b>操作步骤:</b>`,
      `1️⃣ 点击上方链接，确认是同一商品`,
      `2️⃣ 加入进货单 → 结算`,
      `3️⃣ 收货地址: ${skuMatches[0]?.freightAddress || process.env.FREIGHT_ADDRESS}`,
      `4️⃣ 完成付款后，记下1688订单号`,
      ``,
      `<b>回填命令:</b>`,
      `<code>curl -X POST .../api/v1/procurement/confirm -d '{"postingNumber":"${order.postingNumber}","alibabaOrderId":"1688订单号","amountCny":${result.totalAmountCny}}'</code>`,
      ``,
      `<i>⏰ 请在24小时内完成，超时将重复提醒</i>`,
    ].join("\n");

    await notifier.notify({
      level: "info",
      event: "PURCHASE_PENDING_PAYMENT",
      message,
      correlationId: result.postingNumber,
      force: true,
      metadata: {
        postingNumber: result.postingNumber,
        purchaseId: result.purchaseId || "",
        amountCny: String(result.totalAmountCny),
        sourceUrls: JSON.stringify(sourceUrls),
      },
    });
  }

  // ==============================================================
  // 5. Batch Procurement Run
  // ==============================================================

  /**
   * Full procurement cycle: sync → match → profit check → create purchase → notify.
   * Called by scheduled job and manual trigger.
   */
  async runProcurementBatch(ozonClient: unknown): Promise<PurchaseBatchResult> {
    const result: PurchaseBatchResult = {
      total: 0, matched: 0, profitBlocked: 0, created: 0, failed: 0, skipped: 0, results: [],
    };

    if (!this.enabled) {
      logger.info("ManualProcurement: MANUAL_PAY_MODE not enabled, skipping batch");
      return result;
    }

    const { matched } = await this.syncAndMatch(ozonClient);
    result.total = matched.length;

    for (const { order, skuMatches } of matched) {
      result.matched++;

      // Check if any SKU matched
      if (!skuMatches.some((m) => m.matched)) {
        result.skipped++;
        logger.warn({ postingNumber: order.postingNumber }, "ManualProcurement: no SKU match — skipped");
        continue;
      }

      // Supplier quality check (24h揽收率 ≥ 90%)
      const supplierRejected = this.checkSupplierQuality(skuMatches, order);
      if (supplierRejected) {
        result.failed++;
        continue;
      }

      // Profit check
      const profit = await this.checkProfit(order, skuMatches);
      if (!profit.passed) {
        result.profitBlocked++;
        // TG alert for blocked orders
        await notifier.notify({
          level: "warn",
          event: "PURCHASE_PROFIT_BLOCKED",
          message: `⚠️ 利润拦截: ${order.postingNumber}\n售价: ${profit.priceRub} RUB\n采购成本: ¥${Math.round(profit.purchaseCostCny)} CNY\n预估物流: ${profit.estimatedLogisticsRub} RUB\n利润率: ${profit.marginPercent} (阈值: ${profit.threshold})\n${profit.reason || ""}`,
          correlationId: order.postingNumber,
          force: true,
        });
        continue;
      }

      // Create purchase order
      const purchaseResult = await this.createPurchaseOrder(order, skuMatches);
      result.results.push(purchaseResult);

      if (purchaseResult.success) {
        result.created++;
        // Send payment reminder
        await this.sendPaymentReminder(purchaseResult, order, skuMatches);
      } else if (purchaseResult.paymentStatus === "exists") {
        result.skipped++;
      } else {
        result.failed++;
      }
    }

    logger.info({
      total: result.total, matched: result.matched, created: result.created,
      profitBlocked: result.profitBlocked, failed: result.failed,
    }, "ManualProcurement: batch procurement complete");

    return result;
  }

  // ==============================================================
  // 6. 24h Unpaid Reminder
  // ==============================================================

  /**
   * Check for purchases pending manual payment > 24h and re-notify.
   */
  async remindUnpaidOrders(): Promise<number> {
    if (!this.db) return 0;

    const rows = await this.db.all<{
      id: string; ozon_posting_number: string; total_amount_cny: number;
      created_at: string;
    }>(
      `SELECT id, ozon_posting_number, total_amount_cny, created_at
       FROM purchase_1688
       WHERE payment_status = 'pending_payment'
       AND datetime(created_at) < datetime('now', '-24 hours')
       LIMIT 50`
    );

    for (const r of rows) {
      const hours = Math.round((Date.now() - new Date(r.created_at).getTime()) / 3600000);
      await notifier.notify({
        level: "warn",
        event: "PURCHASE_UNPAID_REMINDER",
        message: [
          `⏰ <b>采购单未支付提醒 — 已超${hours}小时</b>`,
          ``,
          `<b>Ozon订单:</b> <code>${r.ozon_posting_number}</code>`,
          `<b>采购单号:</b> <code>${r.id}</code>`,
          `<b>金额:</b> ¥${r.total_amount_cny} CNY`,
          ``,
          `⚠️ 请尽快登录1688后台完成支付，避免Ozon超时发货罚款！`,
          `🔗 https://work.1688.com/home/buyer.htm`,
        ].join("\n"),
        correlationId: r.ozon_posting_number,
        force: true,
        metadata: { postingNumber: r.ozon_posting_number, purchaseId: r.id, hours: String(hours) },
      });
    }

    if (rows.length > 0) {
      logger.warn({ count: rows.length }, "ManualProcurement: unpaid reminders sent");
    }

    return rows.length;
  }

  // ==============================================================
  // 7. 1688 Callback Handler
  // ==============================================================

  /**
   * Handle 1688 message callbacks for payment status updates.
   * Called by the 1688 callback route.
   */
  async handlePaymentCallback(payload: {
    messageType?: string;
    orderId?: string;
    payStatus?: string;
    payTime?: string;
    paySerial?: string;
    logisticsStatus?: string;
    logisticsTracking?: string;
  }): Promise<void> {
    if (!this.db) return;

    const messageType = payload.messageType || "";
    const orderId = payload.orderId || "";

    if (!orderId) return;

    if (messageType === "ORDER_PAID" || payload.payStatus === "paid") {
      await this.db.run(
        `UPDATE purchase_1688
         SET payment_status = 'paid', pay_serial = ?, pay_time = ?, updated_at = datetime('now')
         WHERE (id = ? OR ozon_posting_number = ?)`,
        [payload.paySerial || "", payload.payTime || new Date().toISOString(), orderId, orderId]
      );

      await notifier.notify({
        level: "info",
        event: "PURCHASE_PAID_CONFIRMED",
        message: `✅ 采购单已支付: ${orderId}`,
        correlationId: orderId,
        metadata: { orderId, payTime: payload.payTime || "" },
      });
    }

    if (messageType === "SUPPLIER_SHIPPED" || payload.logisticsStatus === "shipped") {
      await this.db.run(
        `UPDATE purchase_1688
         SET logistics_status = 'shipped', logistics_tracking = ?, updated_at = datetime('now')
         WHERE (id = ? OR ozon_posting_number = ?)`,
        [payload.logisticsTracking || "", orderId, orderId]
      );
    }
  }

  // ==============================================================
  // 8. Polling Fallback — check 1688 order status periodically
  // ==============================================================

  /**
   * Poll 1688 API for purchase order status (fallback when callback fails).
   * Checks all pending_payment orders and updates status from 1688.
   */
  async pollPurchaseStatus(): Promise<number> {
    if (!this.db) return 0;

    const rows = await this.db.all<{ id: string; ozon_posting_number: string }>(
      `SELECT id, ozon_posting_number FROM purchase_1688
       WHERE payment_status = 'pending_payment'
       LIMIT 100`
    );

    // For each pending order, try to query 1688 for status
    // In transition mode without real 1688 API polling, we rely on callbacks
    // This is the fallback placeholder
    logger.debug({ pendingCount: rows.length }, "ManualProcurement: polling purchase status");

    return rows.length;
  }

  // ==============================================================
  // 9. Confirm Manual Payment (方案B: 用户在1688手动下单后回填)
  // ==============================================================

  async confirmManualPayment(params: {
    postingNumber?: string;
    purchaseId?: string;
    alibabaOrderId?: string;
    amountCny?: number;
  }): Promise<{ success: boolean; message: string }> {
    if (!this.db) return { success: false, message: "DB unavailable" };

    const where = params.purchaseId
      ? "id = ?"
      : "ozon_posting_number = ?";
    const value = params.purchaseId || params.postingNumber;

    // Find the pending purchase
    const rows = await this.db.all<{ id: string; payment_status: string; ozon_posting_number: string }>(
      `SELECT id, payment_status, ozon_posting_number FROM purchase_1688 WHERE ${where}`,
      [value]
    );

    if (rows.length === 0) {
      return { success: false, message: `采购单不存在: ${value}` };
    }

    const purchase = rows[0]!;
    if (purchase.payment_status === "paid") {
      return { success: false, message: `采购单 ${purchase.id} 已经是已支付状态，无需重复确认` };
    }

    // Mark as paid
    const now = new Date().toISOString();
    await this.db.run(
      `UPDATE purchase_1688
       SET payment_status = 'paid',
           pay_time = ?,
           alibaba_order_id = COALESCE(NULLIF(?, ''), alibaba_order_id),
           ${params.amountCny ? "total_amount_cny = ?," : ""}
           updated_at = ?
       WHERE id = ?`,
      params.amountCny
        ? [now, params.alibabaOrderId || "", params.amountCny, now, purchase.id]
        : [now, params.alibabaOrderId || "", now, purchase.id]
    );

    logger.info({
      purchaseId: purchase.id,
      postingNumber: purchase.ozon_posting_number,
      alibabaOrderId: params.alibabaOrderId,
      amountCny: params.amountCny,
    }, "ManualProcurement: payment manually confirmed");

    // TG notification
    await notifier.notify({
      level: "info",
      event: "PURCHASE_PAID_CONFIRMED",
      message: `✅ 采购单已手动确认支付\nOzon: ${purchase.ozon_posting_number}\n1688订单号: ${params.alibabaOrderId || "(未填写)"}\n金额: ¥${params.amountCny || "?"} CNY\n\n下一步: 等待1688发货 → 收到货后推送给跨境巴士`,
      correlationId: purchase.ozon_posting_number,
    });

    return { success: true, message: `采购单 ${purchase.id} 已确认支付` };
  }

  // ==============================================================
  // 10. Unpaid Purchase List (for diagnostics)
  // ==============================================================

  async getUnpaidPurchases(): Promise<Array<{
    purchaseId: string; postingNumber: string; amountCny: number;
    createdAt: string; hoursSince: number;
  }>> {
    if (!this.db) return [];

    const rows = await this.db.all<{
      id: string; ozon_posting_number: string; total_amount_cny: number; created_at: string;
    }>(
      `SELECT id, ozon_posting_number, total_amount_cny, created_at
       FROM purchase_1688
       WHERE payment_status = 'pending_payment'
       ORDER BY created_at DESC
       LIMIT 200`
    );

    return rows.map((r) => ({
      purchaseId: r.id,
      postingNumber: r.ozon_posting_number,
      amountCny: r.total_amount_cny,
      createdAt: r.created_at,
      hoursSince: Math.round((Date.now() - new Date(r.created_at).getTime()) / 3600000),
    }));
  }
}
