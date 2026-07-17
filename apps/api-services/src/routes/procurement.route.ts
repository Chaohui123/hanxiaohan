// ============================================================
// Procurement Routes — MANUAL_PAY_MODE 1688采购管理
// POST /api/procurement/sync     — trigger order sync + purchase creation
// GET  /api/procurement/unpaid   — list unpaid purchases
// POST /api/procurement/remind   — trigger unpaid reminders
// POST /api/procurement/callback — 1688 payment/shipping callbacks
// ============================================================

import { Router } from "express";
import { getDb } from "../db/connection.js";
import { ManualProcurementService } from "../services/manual-procurement.js";
import { logger } from "@onzo/logger";
import type { OzonClient } from "@onzo/ozon-api-wrapper";

export function createProcurementRouter(ozonClient: OzonClient): Router {
  const router = Router();

  /** POST /api/procurement/sync — trigger full procurement cycle */
  router.post("/procurement/sync", async (_req, res) => {
    const db = await getDb().catch(() => null);
    const service = new ManualProcurementService(db);

    if (!service.enabled) {
      res.status(404).json({ success: false, error: { code: "DISABLED", message: "Set MANUAL_PAY_MODE=true to enable" } });
      return;
    }

    try {
      const result = await service.runProcurementBatch(ozonClient);
      res.json({ success: true, data: result, correlationId: _req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "PROCUREMENT_ERROR", message: (err as Error).message } });
    }
  });

  /** GET /api/procurement/unpaid — list pending payment purchases */
  router.get("/procurement/unpaid", async (_req, res) => {
    const db = await getDb().catch(() => null);
    const service = new ManualProcurementService(db);

    if (!service.enabled) {
      res.status(404).json({ success: false, error: { code: "DISABLED", message: "Set MANUAL_PAY_MODE=true to enable" } });
      return;
    }

    try {
      const unpaid = await service.getUnpaidPurchases();
      res.json({ success: true, data: unpaid, count: unpaid.length });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "QUERY_ERROR", message: (err as Error).message } });
    }
  });

  /** POST /api/procurement/remind — trigger unpaid reminders */
  router.post("/procurement/remind", async (_req, res) => {
    const db = await getDb().catch(() => null);
    const service = new ManualProcurementService(db);

    if (!service.enabled) {
      res.status(404).json({ success: false, error: { code: "DISABLED", message: "Set MANUAL_PAY_MODE=true to enable" } });
      return;
    }

    try {
      const count = await service.remindUnpaidOrders();
      res.json({ success: true, data: { remindersSent: count } });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "REMIND_ERROR", message: (err as Error).message } });
    }
  });

  /** POST /api/procurement/callback — 1688 payment/shipping status callback */
  router.post("/procurement/callback", async (req, res) => {
    const db = await getDb().catch(() => null);
    const service = new ManualProcurementService(db);

    try {
      const body = req.body as Record<string, unknown>;
      await service.handlePaymentCallback({
        messageType: body.messageType as string,
        orderId: body.orderId as string || body.order_id as string,
        payStatus: body.payStatus as string || body.pay_status as string,
        payTime: body.payTime as string || body.pay_time as string,
        paySerial: body.paySerial as string || body.pay_serial as string,
        logisticsStatus: body.logisticsStatus as string,
        logisticsTracking: body.logisticsTracking as string,
      });
      res.json({ success: true });
    } catch (err) {
      logger.error({ err: (err as Error).message }, "Procurement callback failed");
      res.json({ success: false, error: { code: "CALLBACK_ERROR", message: (err as Error).message } });
    }
  });

  /** POST /api/procurement/confirm — manual: user completed 1688 payment, confirm here */
  router.post("/procurement/confirm", async (req, res) => {
    const db = await getDb().catch(() => null);
    const service = new ManualProcurementService(db);

    if (!service.enabled) {
      res.status(404).json({ success: false, error: { code: "DISABLED", message: "Set MANUAL_PAY_MODE=true to enable" } });
      return;
    }

    try {
      const body = req.body as { postingNumber?: string; purchaseId?: string; alibabaOrderId?: string; amountCny?: number };
      if (!body.postingNumber && !body.purchaseId) {
        res.status(400).json({ success: false, error: { code: "MISSING", message: "postingNumber or purchaseId required" } });
        return;
      }

      const result = await service.confirmManualPayment({
        postingNumber: body.postingNumber,
        purchaseId: body.purchaseId,
        alibabaOrderId: body.alibabaOrderId,
        amountCny: body.amountCny,
      });

      res.json({ success: result.success, data: result });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "CONFIRM_ERROR", message: (err as Error).message } });
    }
  });

  return router;
}
