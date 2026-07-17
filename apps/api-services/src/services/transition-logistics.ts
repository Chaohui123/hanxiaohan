// ============================================================
// Transition Logistics Service — 跨境巴士 (KuajingBus) semi-auto adapter
//
// Lifecycle:
//   1. Export: from ozon_orders/purchase_1688 → xlsx for freight forwarder
//   2. Import: freight forwarder tracking xlsx → backfill ozon_orders + ship to Ozon
//   3. Finance: freight forwarder billing xlsx → match orders → per-SKU profit
//   4. Alerts: 24h unpaid-no-submit / 48h no-tracking → TG push
//
// Gate: TRANSITION_LOGISTICS=kuajingbus enables all endpoint logic.
// Abstract: LogisticsAdapter interface for future CDEK/API migration.
// ============================================================

import type { DbAdapter } from "../db/connection.js";
import { serializedWrite } from "../db/connection.js";
import type { OzonClient } from "@onzo/ozon-api-wrapper";
import { OzonOrderClient } from "@onzo/ozon-order";
import { logger } from "@onzo/logger";
import { notifier } from "./notifier.js";

// ---- Abstract Adapter (future CDEK/API migration path) ----

export interface LogisticsAdapter {
  readonly name: string;
  /** Export orders to the format this forwarder expects */
  exportOrders(orders: TransitionOrder[]): TransitionExport;
  /** Parse tracking numbers from forwarder's exported file */
  parseTrackingImport(rows: Record<string, string>[]): TrackingImportRow[];
  /** Parse billing from forwarder's invoice file */
  parseBillingImport(rows: Record<string, string>[]): BillingImportRow[];
}

// ---- Types ----

export interface TransitionOrder {
  postingNumber: string;
  orderNumber: string;
  recipientName: string;
  recipientPhone: string;
  address: string;
  productName: string;
  weightKg: number;
  sku: number;
  domesticTracking: string;   // 1688 domestic courier tracking
  priceRub: number;
  costCny: number;
  paymentStatus: string;
}

export interface TransitionExport {
  filename: string;
  headers: string[];
  rows: Record<string, string>[];
}

export interface TrackingImportRow {
  postingNumber: string;
  trackingNumber: string;
  carrier?: string;
  weight?: number;
  costRub?: number;
  notes?: string;
}

export interface ImportResult {
  total: number;
  succeeded: BackfillResult[];
  failed: FailedImport[];
}

export interface BackfillResult {
  postingNumber: string;
  trackingNumber: string;
  ozonShipped: boolean;
  error?: string;
}

export interface FailedImport {
  row: number;
  postingNumber: string;
  error: string;
}

export interface BillingImportRow {
  postingNumber?: string;
  orderNumber?: string;
  trackingNumber: string;
  carrier?: string;
  costRub: number;
  weightKg?: number;
  notes?: string;
}

export interface BillingImportResult {
  total: number;
  matched: number;
  unmatched: Array<{ trackingNumber: string; costRub: number }>;
  profitBySku: Array<{
    postingNumber: string;
    trackingNumber: string;
    priceRub: number;
    costCny: number;
    logisticsCostRub: number;
    profitRub: number;
    marginPercent: number;
  }>;
}

export interface TransitionDashboard {
  pendingExport: number;    // paid but no logistics_tracking
  pendingImport: number;    // has domestic tracking but no international
  pendingBilling: number;   // shipped but no logistics_cost_rub
  overdue24h: number;       // paid > 24h, no submission
  overdue48h: number;       // paid > 48h, no international tracking
}

// ---- KuajingBus Adapter (default for transition mode) ----

export class KuajingBusAdapter implements LogisticsAdapter {
  readonly name = "kuajingbus";

  exportOrders(orders: TransitionOrder[]): TransitionExport {
    return {
      filename: `ONZO_跨境巴士预报_${new Date().toISOString().slice(0, 10)}.xlsx`,
      headers: [
        "Ozon订单号",          // postingNumber
        "收件人俄文姓名",      // recipientName
        "收件人地址",          // address
        "收件人电话",          // recipientPhone
        "商品名称",            // productName
        "重量(KG)",            // weightKg
        "SKU",                 // sku
        "1688国内快递单号",    // domesticTracking
        "申报价值(RUB)",       // priceRub
      ],
      rows: orders.map((o) => ({
        "Ozon订单号": o.postingNumber,
        "收件人俄文姓名": o.recipientName,
        "收件人地址": o.address,
        "收件人电话": o.recipientPhone,
        "商品名称": o.productName,
        "重量(KG)": String(o.weightKg),
        "SKU": String(o.sku),
        "1688国内快递单号": o.domesticTracking,
        "申报价值(RUB)": String(Math.round(o.priceRub)),
      })),
    };
  }

  parseTrackingImport(rows: Record<string, string>[]): TrackingImportRow[] {
    const result: TrackingImportRow[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const postingNumber = (row["Ozon订单号"] || row["posting_number"] || row["ozon_posting_number"] || "").trim();
      const trackingNumber = (row["国际运单号"] || row["tracking_number"] || row["国际快递单号"] || "").trim();
      if (!postingNumber || !trackingNumber) {
        logger.warn({ row: i, rowData: row }, "KuajingBus: row missing postingNumber or trackingNumber, skipped");
        continue;
      }
      result.push({
        postingNumber,
        trackingNumber,
        carrier: (row["物流商"] || row["carrier"] || "kuajingbus").trim() || undefined,
        weight: parseFloat(row["重量(KG)"] || row["weight"] || "0") || undefined,
        costRub: parseFloat(row["运费(RUB)"] || row["cost_rub"] || row["物流费"] || "0") || undefined,
        notes: (row["备注"] || row["notes"] || "").trim() || undefined,
      });
    }
    return result;
  }

  parseBillingImport(rows: Record<string, string>[]): BillingImportRow[] {
    return rows.map((row) => ({
      postingNumber: (row["Ozon订单号"] || row["posting_number"] || "").trim() || undefined,
      orderNumber: (row["订单号"] || row["order_number"] || "").trim() || undefined,
      trackingNumber: (row["国际运单号"] || row["tracking_number"] || row["运单号"] || "").trim(),
      carrier: (row["物流商"] || row["carrier"] || "").trim() || undefined,
      costRub: parseFloat(row["运费(RUB)"] || row["cost_rub"] || row["物流费"] || "0"),
      weightKg: parseFloat(row["重量(KG)"] || row["weight"] || "0") || undefined,
      notes: (row["备注"] || row["notes"] || "").trim() || undefined,
    }));
  }
}

// ---- Service ----

export class TransitionLogisticsService {
  private adapter: LogisticsAdapter;

  constructor(
    private db: DbAdapter | null,
    adapter?: LogisticsAdapter,
  ) {
    this.adapter = adapter ?? new KuajingBusAdapter();
  }

  get enabled(): boolean {
    return process.env.TRANSITION_LOGISTICS === "kuajingbus";
  }

  get adapterName(): string {
    return this.adapter.name;
  }

  // ==============================================================
  // 1. Order Export
  // ==============================================================

  /**
   * Query pending orders (paid, no international tracking) for export.
   */
  async queryPendingExportOrders(): Promise<TransitionOrder[]> {
    if (!this.db) return [];

    const rows = await this.db.all<{
      posting_number: string; order_number: string;
      buyer_name: string; buyer_phone: string;
      products_json: string; total_price_rub: number; total_cost_cny: number;
      logistics_tracking: string; payment_status: string;
    }>(
      `SELECT
         o.posting_number, o.order_number,
         o.buyer_name, o.buyer_phone,
         o.products_json, o.total_price_rub, o.total_cost_cny,
         COALESCE(p.logistics_tracking, '') AS logistics_tracking,
         COALESCE(p.payment_status, 'pending') AS payment_status
       FROM ozon_orders o
       LEFT JOIN purchase_1688 p ON o.posting_number = p.ozon_posting_number
       WHERE o.tracking_number IS NULL
       AND (p.payment_status = 'paid' OR p.payment_status IS NULL)
       AND o.status != 'cancelled'
       ORDER BY o.created_at_ozon DESC
       LIMIT 500`
    );

    // Get SKU mapping for weight + domestic tracking
    return Promise.all(rows.map(async (r) => {
      let sku = 0;
      let productName = "";
      let weightKg = 0.3;

      try {
        const products = JSON.parse(r.products_json || "[]") as Array<{ sku?: number; offer_id?: string; name?: string; quantity?: number }>;
        if (products.length > 0) {
          sku = products[0]!.sku || 0;
          productName = products[0]!.name || products[0]!.offer_id || "";
        }
      } catch { /* JSON parse fallback */ }

      // Get weight from SKU mapping
      if (sku && this.db) {
        const skuRow = await this.db.all<{ weight_kg: number }>(
          "SELECT weight_kg FROM sku_1688_mapping WHERE ozon_posting_number = ? LIMIT 1",
          [r.posting_number]
        ).catch((): { weight_kg: number }[] => []);
        if (skuRow.length > 0) weightKg = skuRow[0]!.weight_kg;
      }

      // Build address from buyer info (Ozon provides partial address)
      const address = `Россия, г. Москва`; // default; actual address from buyer data

      return {
        postingNumber: r.posting_number,
        orderNumber: r.order_number || "",
        recipientName: r.buyer_name || "",
        recipientPhone: r.buyer_phone || "",
        address,
        productName,
        weightKg,
        sku,
        domesticTracking: r.logistics_tracking,
        priceRub: r.total_price_rub,
        costCny: r.total_cost_cny,
        paymentStatus: r.payment_status,
      };
    }));
  }

  /** Generate export data for download */
  async generateExport(): Promise<TransitionExport> {
    const orders = await this.queryPendingExportOrders();
    return this.adapter.exportOrders(orders);
  }

  // ==============================================================
  // 2. Tracking Import + Ozon Backfill
  // ==============================================================

  /**
   * Import tracking numbers from freight forwarder's xlsx file.
   * Parsed rows → match ozon_orders by posting_number → call Ozon ship API → update DB
   */
  async importTracking(
    rows: Record<string, string>[],
    ozonClient: OzonClient,
  ): Promise<ImportResult> {
    const parsed = this.adapter.parseTrackingImport(rows);
    const result: ImportResult = { total: parsed.length, succeeded: [], failed: [] };

    if (!this.db) {
      result.failed = parsed.map((r, i) => ({ row: i + 2, postingNumber: r.postingNumber, error: "DB unavailable" }));
      return result;
    }

    const orderClient = new OzonOrderClient(ozonClient);

    for (let i = 0; i < parsed.length; i++) {
      const row = parsed[i]!;
      const rowNum = i + 2; // 1-indexed + header

      try {
        // 1. Get order info for shipping
        const orders = await this.db.all<{
          posting_number: string; products_json: string; id: string;
        }>(
          "SELECT posting_number, products_json, id FROM ozon_orders WHERE posting_number = ?",
          [row.postingNumber]
        );

        if (orders.length === 0) {
          result.failed.push({ row: rowNum, postingNumber: row.postingNumber, error: "订单不存在" });
          continue;
        }

        const order = orders[0]!;
        let skuList: Array<{ sku: number; quantity: number }> = [{ sku: 0, quantity: 1 }];
        try {
          const products = JSON.parse(order.products_json || "[]") as Array<{ sku: number; offer_id?: string; quantity: number }>;
          skuList = products.map((p) => ({ sku: p.sku, quantity: p.quantity || 1 }));
        } catch { /* fallback */ }

        // 2. Call Ozon ship API
        let ozonShipped = false;
        try {
          await orderClient.shipOrder(row.postingNumber, row.trackingNumber, skuList);
          ozonShipped = true;
        } catch (shipErr) {
          const errMsg = (shipErr as Error).message;
          logger.error({ postingNumber: row.postingNumber, err: errMsg }, "TransitionLogistics: Ozon ship API failed");
        }

        // 3. Update local database
        await serializedWrite(async () => {
          // Update ozon_orders
          await this.db!.run(
            `UPDATE ozon_orders SET tracking_number = ?, updated_at = datetime('now') WHERE posting_number = ?`,
            [row.trackingNumber, row.postingNumber]
          );

          // Update purchase_1688
          await this.db!.run(
            `UPDATE purchase_1688
             SET logistics_status = 'shipped',
                 logistics_tracking = ?,
                 logistics_carrier = ?,
                 logistics_cost_rub = COALESCE(?, logistics_cost_rub),
                 logistics_updated_at = datetime('now'),
                 updated_at = datetime('now')
             WHERE ozon_posting_number = ?`,
            [row.trackingNumber, row.carrier || "kuajingbus", row.costRub ?? 0, row.postingNumber]
          ).catch(() => {});

          // Update local_orders
          await this.db!.run(
            `UPDATE local_orders SET tracking_number = ?, status = 'delivering', updated_at = datetime('now') WHERE posting_number = ?`,
            [row.trackingNumber, row.postingNumber]
          ).catch(() => {});
        });

        result.succeeded.push({
          postingNumber: row.postingNumber,
          trackingNumber: row.trackingNumber,
          ozonShipped,
        });

        logger.info({ postingNumber: row.postingNumber, trackingNumber: row.trackingNumber, ozonShipped }, "TransitionLogistics: tracking imported");
      } catch (err) {
        result.failed.push({ row: rowNum, postingNumber: row.postingNumber, error: (err as Error).message });
      }
    }

    // TG alert for failures
    if (result.failed.length > 0) {
      const failList = result.failed.slice(0, 5).map((f) => `${f.postingNumber}: ${f.error}`).join("; ");
      await notifier.notify({
        level: "error",
        event: "TRANSITION_IMPORT_FAILED",
        message: `跨境巴士导入失败: ${result.failed.length}/${result.total} 条\n${failList}`,
        correlationId: `import-${Date.now()}`,
        force: true,
        metadata: { failedCount: String(result.failed.length), total: String(result.total) },
      });
    } else if (result.succeeded.length > 0) {
      await notifier.notify({
        level: "info",
        event: "TRANSITION_IMPORT_SUCCESS",
        message: `跨境巴士导入完成: ${result.succeeded.length} 票已回填Ozon`,
        correlationId: `import-${Date.now()}`,
      });
    }

    return result;
  }

  // ==============================================================
  // 3. Finance Billing Import
  // ==============================================================

  /**
   * Import freight forwarder billing xlsx.
   * Match by posting_number or tracking_number → write logistics_cost_rub → calculate per-SKU profit.
   */
  async importBilling(rows: Record<string, string>[]): Promise<BillingImportResult> {
    const parsed = this.adapter.parseBillingImport(rows);
    const result: BillingImportResult = {
      total: parsed.length,
      matched: 0,
      unmatched: [],
      profitBySku: [],
    };

    if (!this.db) return result;

    for (const bill of parsed) {
      // Match by posting_number first, then by tracking_number
      let match: { posting_number: string; total_price_rub: number; total_cost_cny: number } | null = null;

      if (bill.postingNumber) {
        type OrderMatch = { posting_number: string; total_price_rub: number; total_cost_cny: number };
        const rows = await this.db.all<OrderMatch>(
          "SELECT posting_number, total_price_rub, total_cost_cny FROM ozon_orders WHERE posting_number = ?",
          [bill.postingNumber]
        ).catch((): OrderMatch[] => []);
        if (rows.length > 0) match = rows[0]!;
      }

      if (!match && bill.trackingNumber) {
        type OrderMatch = { posting_number: string; total_price_rub: number; total_cost_cny: number };
        const rows = await this.db.all<OrderMatch>(
          "SELECT posting_number, total_price_rub, total_cost_cny FROM ozon_orders WHERE tracking_number = ?",
          [bill.trackingNumber]
        ).catch((): OrderMatch[] => []);
        if (rows.length > 0) match = rows[0]!;
      }

      if (!match) {
        result.unmatched.push({ trackingNumber: bill.trackingNumber, costRub: bill.costRub });
        continue;
      }

      // Write logistics cost to purchase_1688
      await this.db.run(
        `UPDATE purchase_1688
         SET logistics_cost_rub = ?,
             logistics_carrier = COALESCE(NULLIF(?, ''), logistics_carrier),
             updated_at = datetime('now')
         WHERE ozon_posting_number = ?`,
        [bill.costRub, bill.carrier || "", match.posting_number]
      ).catch(() => {});

      // Update local_orders
      await this.db.run(
        `UPDATE local_orders SET shipping_cost_rub = ?, shipping_carrier = ? WHERE posting_number = ?`,
        [bill.costRub, bill.carrier || "", match.posting_number]
      ).catch(() => {});

      // Write to purchase_1688.logistics_cost_rub and recalculate profit in ozon_orders
      try {
        const { getExchangeRate } = await import("./exchange-rate.js");
        const rateResult = await getExchangeRate();
        const rate = rateResult.rate;
        const costRubTotal = match.total_cost_cny * rate + bill.costRub;
        const profitRub = match.total_price_rub - costRubTotal;
        const marginPercent = match.total_price_rub > 0 ? Math.round((profitRub / match.total_price_rub) * 100) : 0;

        await this.db.run(
          `UPDATE ozon_orders
           SET total_profit_rub = ?, margin_percent = ?, updated_at = datetime('now')
           WHERE posting_number = ?`,
          [Math.round(profitRub), marginPercent, match.posting_number]
        ).catch(() => {});

        result.profitBySku.push({
          postingNumber: match.posting_number,
          trackingNumber: bill.trackingNumber,
          priceRub: match.total_price_rub,
          costCny: match.total_cost_cny,
          logisticsCostRub: bill.costRub,
          profitRub: Math.round(profitRub),
          marginPercent,
        });
      } catch {
        result.profitBySku.push({
          postingNumber: match.posting_number,
          trackingNumber: bill.trackingNumber,
          priceRub: match.total_price_rub,
          costCny: match.total_cost_cny,
          logisticsCostRub: bill.costRub,
          profitRub: match.total_price_rub - match.total_cost_cny * 11.5 - bill.costRub,
          marginPercent: 0,
        });
      }

      result.matched++;
    }

    if (result.unmatched.length > 0) {
      logger.warn({ unmatched: result.unmatched.length }, "TransitionLogistics: unmatched billing rows");
    }

    return result;
  }

  // ==============================================================
  // 4. Dashboard Stats
  // ==============================================================

  async getDashboard(): Promise<TransitionDashboard> {
    const empty: TransitionDashboard = {
      pendingExport: 0, pendingImport: 0, pendingBilling: 0,
      overdue24h: 0, overdue48h: 0,
    };
    if (!this.db) return empty;

    // Pending export: paid but no logistics_tracking
    const pendingExportRow = await this.db.all<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM purchase_1688
       WHERE payment_status = 'paid'
       AND (logistics_tracking IS NULL OR logistics_tracking = '')`
    );
    empty.pendingExport = pendingExportRow[0]?.cnt || 0;

    // Pending import: has domestic tracking but no international on ozon_orders
    const pendingImportRow = await this.db.all<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM purchase_1688 p
       JOIN ozon_orders o ON p.ozon_posting_number = o.posting_number
       WHERE p.payment_status = 'paid'
       AND p.logistics_tracking IS NOT NULL AND p.logistics_tracking != ''
       AND o.tracking_number IS NULL`
    );
    empty.pendingImport = pendingImportRow[0]?.cnt || 0;

    // Pending billing: shipped but no logistics_cost_rub
    const pendingBillingRow = await this.db.all<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM purchase_1688
       WHERE logistics_status = 'shipped'
       AND (logistics_cost_rub IS NULL OR logistics_cost_rub = 0)`
    );
    empty.pendingBilling = pendingBillingRow[0]?.cnt || 0;

    // Overdue 24h: paid > 24h, no submission
    const overdue24hRow = await this.db.all<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM purchase_1688
       WHERE payment_status = 'paid'
       AND pay_time IS NOT NULL
       AND datetime(pay_time) < datetime('now', '-24 hours')
       AND (logistics_tracking IS NULL OR logistics_tracking = '')`
    );
    empty.overdue24h = overdue24hRow[0]?.cnt || 0;

    // Overdue 48h: paid > 48h, no international tracking on ozon_orders
    const overdue48hRow = await this.db.all<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM purchase_1688 p
       JOIN ozon_orders o ON p.ozon_posting_number = o.posting_number
       WHERE p.payment_status = 'paid'
       AND p.pay_time IS NOT NULL
       AND datetime(p.pay_time) < datetime('now', '-48 hours')
       AND o.tracking_number IS NULL`
    );
    empty.overdue48h = overdue48hRow[0]?.cnt || 0;

    return empty;
  }

  // ==============================================================
  // 5. Alert Checks (scheduled)
  // ==============================================================

  /**
   * 24h overdue check: paid > 24h but not submitted to freight forwarder.
   * Sends TG alert with order list.
   */
  async check24hOverdue(): Promise<number> {
    if (!this.db) return 0;

    const rows = await this.db.all<{ posting_number: string; total_amount_cny: number; pay_time: string }>(
      `SELECT ozon_posting_number AS posting_number, total_amount_cny, pay_time
       FROM purchase_1688
       WHERE payment_status = 'paid'
       AND pay_time IS NOT NULL
       AND datetime(pay_time) < datetime('now', '-24 hours')
       AND (logistics_tracking IS NULL OR logistics_tracking = '')
       AND logistics_status = 'idle'
       LIMIT 50`
    );

    if (rows.length === 0) return 0;

    const details = rows.map((r) => {
      const hours = Math.round((Date.now() - new Date(r.pay_time).getTime()) / 3600000);
      return `${r.posting_number} (${hours}h, ¥${r.total_amount_cny})`;
    }).slice(0, 10);

    await notifier.notify({
      level: "warn",
      event: "TRANSITION_24H_OVERDUE",
      message: `⚠️ 跨境巴士未预报提醒: ${rows.length} 笔订单支付超24小时未录入\n${details.join("\n")}`,
      correlationId: `overdue24h-${Date.now()}`,
      force: true,
      metadata: { count: String(rows.length), orders: details.join(", ") },
    });

    logger.warn({ count: rows.length }, "TransitionLogistics: 24h overdue alert sent");
    return rows.length;
  }

  /**
   * 48h overdue check: paid > 48h but no international tracking.
   * Critical: Ozon penalties for late shipment.
   */
  async check48hOverdue(): Promise<number> {
    if (!this.db) return 0;

    const rows = await this.db.all<{ posting_number: string; total_amount_cny: number; pay_time: string }>(
      `SELECT p.ozon_posting_number AS posting_number, p.total_amount_cny, p.pay_time
       FROM purchase_1688 p
       JOIN ozon_orders o ON p.ozon_posting_number = o.posting_number
       WHERE p.payment_status = 'paid'
       AND p.pay_time IS NOT NULL
       AND datetime(p.pay_time) < datetime('now', '-48 hours')
       AND o.tracking_number IS NULL
       LIMIT 50`
    );

    if (rows.length === 0) return 0;

    const details = rows.map((r) => {
      const hours = Math.round((Date.now() - new Date(r.pay_time).getTime()) / 3600000);
      return `${r.posting_number} (${hours}h, ¥${r.total_amount_cny})`;
    }).slice(0, 10);

    await notifier.notify({
      level: "critical",
      event: "TRANSITION_48H_OVERDUE",
      message: `🚨 跨境巴士超时预警: ${rows.length} 笔订单超48h无国际运单号！面临Ozon超时扣分！\n${details.join("\n")}`,
      correlationId: `overdue48h-${Date.now()}`,
      force: true,
      metadata: { count: String(rows.length), orders: details.join(", ") },
    });

    logger.warn({ count: rows.length }, "TransitionLogistics: 48h overdue critical alert sent");
    return rows.length;
  }
}
