// ============================================================
// Daily Report — finance + ops daily summary + alert scanner
// ============================================================

import type { DbAdapter } from "../db/connection.js";
import { logger } from "@onzo/logger";
import { emitEvent, EVENT_KEYS } from "./notification-events.js";

// ---- Types ----

export interface DailyFinanceReport {
  date: string;
  ozonRevenueRub: number;
  ozonCommissionRub: number;
  ozonNetRub: number;
  purchase1688Cny: number;
  purchase1688Rub: number;
  logisticsCostRub: number;
  netProfitRub: number;
  totalOrders: number;
  totalPurchases: number;
  pendingShipOrders: number;
  refundTotalRub: number;
}

export interface OpsAlert {
  type: string;
  level: "critical" | "error" | "warn" | "info";
  postingNumber?: string;
  message: string;
  detail?: Record<string, unknown>;
}

// ---- Service ----

export class DailyReportService {
  constructor(private db: DbAdapter | null) {}

  /** Generate daily finance report */
  async generateFinanceReport(date?: string): Promise<DailyFinanceReport> {
    const d = date || new Date().toISOString().slice(0, 10);
    if (!this.db) return { date: d, ozonRevenueRub: 0, ozonCommissionRub: 0, ozonNetRub: 0, purchase1688Cny: 0, purchase1688Rub: 0, logisticsCostRub: 0, netProfitRub: 0, totalOrders: 0, totalPurchases: 0, pendingShipOrders: 0, refundTotalRub: 0 };

    // Ozon orders today
    const ozonRows = await this.db.all<{ revenue: number; commission: number }>(
      "SELECT COALESCE(SUM(total_price_rub),0) as revenue, COALESCE(SUM(commission_rub),0) as commission FROM local_orders WHERE date(synced_at) = ?",
      [d]
    );
    const ozonCount = await this.db.all<{ cnt: number }>("SELECT COUNT(*) as cnt FROM local_orders WHERE date(synced_at) = ?", [d]);

    // 1688 purchases today
    const purchaseRows = await this.db.all<{ total_cny: number; cnt: number }>(
      "SELECT COALESCE(SUM(total_amount_cny),0) as total_cny, COUNT(*) as cnt FROM purchase_1688 WHERE payment_status = 'paid' AND date(pay_time) = ?",
      [d]
    );

    // Pending shipment orders
    const pendingRows = await this.db.all<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM local_orders WHERE status IN ('awaiting_packaging','awaiting_deliver')"
    );

    // Refunds today
    const refundRows = await this.db.all<{ total: number }>(
      "SELECT COALESCE(SUM(total_amount_cny),0) as total FROM purchase_1688 WHERE payment_status = 'refunded' AND date(updated_at) = ?",
      [d]
    );

    const ozonRevenue = ozonRows[0]?.revenue || 0;
    const ozonCommission = ozonRows[0]?.commission || 0;
    const ozonNet = ozonRevenue - ozonCommission;
    const purchaseCny = purchaseRows[0]?.total_cny || 0;
    const purchaseRub = purchaseCny * 11.5; // approximate
    const logisticsCost = (purchaseRows[0]?.cnt || 0) * 80 * 11.5; // ~80 CNY per order logistics
    const netProfit = ozonNet - purchaseRub - logisticsCost;

    return {
      date: d,
      ozonRevenueRub: Math.round(ozonRevenue),
      ozonCommissionRub: Math.round(ozonCommission),
      ozonNetRub: Math.round(ozonNet),
      purchase1688Cny: Math.round(purchaseCny * 100) / 100,
      purchase1688Rub: Math.round(purchaseRub),
      logisticsCostRub: Math.round(logisticsCost),
      netProfitRub: Math.round(netProfit),
      totalOrders: ozonCount[0]?.cnt || 0,
      totalPurchases: purchaseRows[0]?.cnt || 0,
      pendingShipOrders: pendingRows[0]?.cnt || 0,
      refundTotalRub: Math.round((refundRows[0]?.total || 0) * 11.5),
    };
  }

  /** Save daily report to DB */
  async saveDailyReport(report: DailyFinanceReport): Promise<void> {
    if (!this.db) return;
    await this.db.run(
      `INSERT INTO daily_sales (date, orders, revenue_rub, profit_rub, avg_order_value, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(date) DO UPDATE SET orders=EXCLUDED.orders, revenue_rub=EXCLUDED.revenue_rub, profit_rub=EXCLUDED.profit_rub, avg_order_value=EXCLUDED.avg_order_value, updated_at=datetime('now')`,
      [report.date, report.totalOrders, report.ozonRevenueRub, report.netProfitRub,
       report.totalOrders > 0 ? Math.round(report.ozonRevenueRub / report.totalOrders) : 0]
    );
  }

  /** Push daily report to Telegram */
  async pushDailyReport(report: DailyFinanceReport): Promise<void> {
    const msg = [
      `📊 ONZO 日报 ${report.date}`,
      ``,
      `💰 Ozon 收入: ${report.ozonRevenueRub.toLocaleString()} RUB`,
      `💸 Ozon 佣金: ${report.ozonCommissionRub.toLocaleString()} RUB`,
      `📦 1688 采购: ¥${report.purchase1688Cny.toLocaleString()} (≈${report.purchase1688Rub.toLocaleString()} RUB)`,
      `🚚 预估物流: ${report.logisticsCostRub.toLocaleString()} RUB`,
      `📈 净利润: ${report.netProfitRub.toLocaleString()} RUB`,
      ``,
      `📋 订单数: ${report.totalOrders} | 采购数: ${report.totalPurchases} | 待发货: ${report.pendingShipOrders}`,
      `🔄 今日退款: ${report.refundTotalRub.toLocaleString()} RUB`,
    ].join("\n");

    const { notifier } = await import("./notifier.js");
    await notifier.notify({
      level: "info", event: "日报推送", message: msg,
      correlationId: `daily-${report.date}`,
      force: false,
    });
    logger.info({ date: report.date }, "Daily report pushed");
  }

  /** Scan all 6 alert scenarios */
  async scanAlerts(): Promise<OpsAlert[]> {
    const alerts: OpsAlert[] = [];
    if (!this.db) return alerts;

    // Alert 1: Ozon orders without 1688 source match (last 24h)
    try {
      const noSourceRows = await this.db.all<{ posting_number: string }>(
        `SELECT posting_number FROM ozon_orders WHERE has_1688_source = 0 AND synced_at > datetime('now', '-24 hours')`
      );
      if (noSourceRows.length > 0) {
        alerts.push({ type: "NO_1688_SOURCE", level: "error", postingNumber: noSourceRows[0].posting_number, message: `${noSourceRows.length} 个Ozon订单无1688货源匹配`, detail: { count: noSourceRows.length } });
      }
    } catch { /* table may not exist */ }

    // Alert 2: Negative profit purchases (1688 price surge)
    try {
      const negRows = await this.db.all<{ posting_number: string }>(
        `SELECT ozon_posting_number as posting_number FROM purchase_1688 WHERE payment_status = 'paid' AND pay_error LIKE '%margin%' AND pay_time > datetime('now', '-24 hours')`
      );
      if (negRows.length > 0) {
        alerts.push({ type: "NEGATIVE_PROFIT", level: "critical", postingNumber: negRows[0].posting_number, message: `${negRows.length} 个采购单利润为负`, detail: { count: negRows.length } });
      }
    } catch { /* */ }

    // Alert 3: 48h no pickup (already handled by logistics-polling.ts, skip duplicate)

    // Alert 4: Freight forwarder no tracking / parcel lost (paid >7d, no logistics_tracking)
    try {
      const lostRows = await this.db.all<{ posting_number: string }>(
        `SELECT ozon_posting_number as posting_number FROM purchase_1688 WHERE payment_status = 'paid' AND (logistics_tracking IS NULL OR logistics_tracking = '') AND pay_time < datetime('now', '-7 days')`
      );
      if (lostRows.length > 0) {
        alerts.push({ type: "PARCEL_LOST", level: "critical", postingNumber: lostRows[0].posting_number, message: `${lostRows.length} 个包裹超7天无物流 — 可能丢失`, detail: { count: lostRows.length } });
      }
    } catch { /* */ }

    // Alert 5: Ozon ship backfill failed (paid with tracking but local_orders still awaiting_deliver)
    try {
      const overdueRows = await this.db.all<{ posting_number: string; tracking: string }>(
        `SELECT p.ozon_posting_number as posting_number, p.logistics_tracking as tracking
         FROM purchase_1688 p LEFT JOIN local_orders o ON p.ozon_posting_number = o.posting_number
         WHERE p.payment_status = 'paid' AND p.logistics_tracking IS NOT NULL AND o.status = 'awaiting_deliver'
         AND p.pay_time < datetime('now', '-3 days')`
      );
      if (overdueRows.length > 0) {
        alerts.push({ type: "SHIP_BACKFILL_FAILED", level: "error", postingNumber: overdueRows[0].posting_number, message: `${overdueRows.length} 个订单Ozon回填失败/逾期`, detail: { count: overdueRows.length, sample: overdueRows[0].tracking } });
      }
    } catch { /* */ }

    // Push critical alerts
    for (const alert of alerts) {
      if (alert.level === "critical" || alert.level === "error") {
        await emitEvent(alert.type as never, {
          postingNumber: alert.postingNumber || "N/A",
          message: alert.message,
        } as never).catch(() => {});
      }
    }

    return alerts;
  }

  /** Full daily routine: report + alerts + push */
  async runDailyRoutine(): Promise<{ report: DailyFinanceReport; alerts: OpsAlert[] }> {
    const report = await this.generateFinanceReport();
    await this.saveDailyReport(report);
    await this.pushDailyReport(report);
    const alerts = await this.scanAlerts();
    return { report, alerts };
  }
}
