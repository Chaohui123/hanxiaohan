// ============================================================
// Report Routes — daily finance + alert scanner + Excel export
// ============================================================

import { Router } from "express";
import { getDb } from "../db/connection.js";
import { DailyReportService } from "../services/daily-report.js";

export function createReportRouter(): Router {
  const router = Router();

  /** GET /api/report/finance?date=2026-07-15 — daily finance report */
  router.get("/report/finance", async (req, res) => {
    try {
      const db = await getDb().catch(() => null);
      const service = new DailyReportService(db);
      const report = await service.generateFinanceReport(req.query.date as string);
      res.json({ success: true, data: report, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "REPORT_ERROR", message: (err as Error).message } });
    }
  });

  /** GET /api/report/alerts — scan all ops alerts */
  router.get("/report/alerts", async (_req, res) => {
    try {
      const db = await getDb().catch(() => null);
      const service = new DailyReportService(db);
      const alerts = await service.scanAlerts();
      res.json({ success: true, data: alerts, count: alerts.length });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "ALERTS_ERROR", message: (err as Error).message } });
    }
  });

  /** GET /api/report/export?date=2026-07-15 — Excel export purchase ledger */
  router.get("/report/export", async (req, res) => {
    try {
      const db = await getDb().catch(() => null);
      const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);
      if (!db) return res.status(503).json({ success: false, error: { code: "DB_UNAVAILABLE" } });

      // Query purchase ledger
      const purchases = await db.all(
        `SELECT id, ozon_posting_number, total_amount_cny, pay_time, pay_channel, payment_status, logistics_tracking
         FROM purchase_1688 WHERE date(pay_time) = ? OR date(created_at) = ? ORDER BY created_at DESC`,
        [date, date]
      ) as Array<Record<string, unknown>>;

      const ozonOrders = await db.all(
        `SELECT posting_number, total_price_rub, commission_rub, payout_rub, synced_at
         FROM local_orders WHERE date(synced_at) = ?`,
        [date]
      ) as Array<Record<string, unknown>>;

      // Build CSV
      const header = "类型,Ozon单号,金额(¥/RUB),佣金/渠道,状态,物流,时间";
      const purchaseLines = purchases.map((p) =>
        `1688采购,${p.ozon_posting_number},¥${p.total_amount_cny},${p.pay_channel || "-"},${p.payment_status},${p.logistics_tracking || "-"},${p.pay_time || p.created_at}`
      ).join("\n");
      const ozonLines = ozonOrders.map((o) =>
        `Ozon收入,${o.posting_number},${(o.total_price_rub as number).toFixed(0)} RUB,${(o.commission_rub as number).toFixed(0)} RUB,${(o.payout_rub as number).toFixed(0)} RUB,-,${o.synced_at}`
      ).join("\n");

      const csv = `${header}\n${purchaseLines}\n${ozonLines}`;
      res.set("Content-Type", "text/csv; charset=utf-8");
      res.set("Content-Disposition", `attachment; filename="ONZO_财务对账_${date}.csv"`);
      res.send("﻿" + csv); // BOM for Excel UTF-8 compatibility
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "EXPORT_ERROR", message: (err as Error).message } });
    }
  });

  /** POST /api/report/run-daily — trigger full daily routine (report + alerts + push) */
  router.post("/report/run-daily", async (_req, res) => {
    try {
      const db = await getDb().catch(() => null);
      const service = new DailyReportService(db);
      const result = await service.runDailyRoutine();
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "DAILY_ERROR", message: (err as Error).message } });
    }
  });

  return router;
}
