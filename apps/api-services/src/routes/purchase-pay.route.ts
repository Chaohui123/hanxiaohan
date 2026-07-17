// ============================================================
// Purchase Pay Routes — trigger payment, retry, status, bill
// ============================================================

import { Router } from "express";
import type { DbAdapter } from "../db/connection.js";
import { PurchasePayService } from "../services/purchase-pay.js";
import { logger } from "@onzo/logger";

export function createPurchasePayRouter(db: DbAdapter | null): Router {
  const router = Router();
  const service = new PurchasePayService(db);

  /** POST /api/purchase/pay — trigger auto-payment for an Ozon order */
  router.post("/purchase/pay", async (req, res) => {
    try {
      const { postingNumber, storeId, costCny, sellingPriceRub, weightKg, source1688Url, skuList, ozonOrderId, offerId } = req.body as {
        postingNumber: string; storeId?: string; costCny: number; sellingPriceRub: number;
        weightKg?: number; source1688Url?: string;
        skuList: Array<{ sku: number; quantity: number; unitPriceCny: number }>;
        ozonOrderId: number; offerId?: string;
      };

      if (!postingNumber || !skuList || skuList.length === 0 || !costCny) {
        return res.status(400).json({
          success: false,
          error: { code: "INVALID_PARAMS", message: "postingNumber, skuList, and costCny are required", retryable: false },
          correlationId: req.correlationId,
        });
      }

      const result = await service.payOrder({
        storeId: storeId || "store_1",
        ozonPostingNumber: postingNumber,
        ozonOrderId: ozonOrderId || 0,
        costCny,
        sellingPriceRub: sellingPriceRub || 0,
        weightKg: weightKg || 0.5,
        source1688Url,
        skuList,
        offerId,
      });

      if (result.success) {
        res.json({ success: true, data: result, correlationId: req.correlationId });
      } else {
        res.status(402).json({ success: false, error: { code: result.errorCode || "PAY_FAILED", message: result.errorMsg, retryable: true }, data: result, correlationId: req.correlationId });
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, "PurchasePay: pay endpoint error");
      res.status(500).json({ success: false, error: { code: "PURCHASE_PAY_ERROR", message: (err as Error).message, retryable: true }, correlationId: req.correlationId });
    }
  });

  /** POST /api/purchase/retry/:id — retry failed payment */
  router.post("/purchase/retry/:id", async (req, res) => {
    try {
      const { id } = req.params;
      if (!db) return res.status(503).json({ success: false, error: { code: "DB_UNAVAILABLE", message: "数据库不可用", retryable: true }, correlationId: req.correlationId });

      const rows = await db.all<Record<string, unknown>>("SELECT * FROM purchase_1688 WHERE id = ?", [id]);
      if (rows.length === 0) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "采购记录不存在", retryable: false }, correlationId: req.correlationId });
      }

      const rec = rows[0];
      const skuList = JSON.parse((rec.sku_list_json as string) || "[]");
      const input = {
        storeId: rec.store_id as string,
        ozonPostingNumber: rec.ozon_posting_number as string,
        ozonOrderId: rec.ozon_order_id as number,
        costCny: rec.total_amount_cny as number,
        sellingPriceRub: 0,
        weightKg: 0.5,
        source1688Url: rec.source_1688_url as string || undefined,
        skuList,
        offerId: rec.offer_id as string || undefined,
      };

      const result = await service.retryFailedPayment(id, input);
      if (result.success) {
        res.json({ success: true, data: result, correlationId: req.correlationId });
      } else {
        res.status(402).json({ success: false, error: { code: result.errorCode || "RETRY_FAILED", message: result.errorMsg, retryable: true }, data: result, correlationId: req.correlationId });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "PURCHASE_RETRY_ERROR", message: (err as Error).message, retryable: true }, correlationId: req.correlationId });
    }
  });

  /** GET /api/purchase/status/:postingNumber */
  router.get("/purchase/status/:postingNumber", async (req, res) => {
    try {
      if (!db) return res.status(503).json({ success: false, error: { code: "DB_UNAVAILABLE", message: "数据库不可用" }, correlationId: req.correlationId });
      const rows = await db.all<Record<string, unknown>>(
        "SELECT * FROM purchase_1688 WHERE ozon_posting_number = ?",
        [req.params.postingNumber]
      );
      if (rows.length === 0) {
        return res.json({ success: true, data: { status: "not_found" }, correlationId: req.correlationId });
      }
      const r = rows[0];
      res.json({
        success: true,
        data: {
          id: r.id, status: r.payment_status, paySerial: r.pay_serial,
          payTime: r.pay_time, channel: r.pay_channel, error: r.pay_error,
          logisticsStatus: r.logistics_status, tracking: r.logistics_tracking,
        },
        correlationId: req.correlationId,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "PURCHASE_STATUS_ERROR", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  /** GET /api/purchase/list */
  router.get("/purchase/list", async (req, res) => {
    try {
      if (!db) return res.status(503).json({ success: false, error: { code: "DB_UNAVAILABLE" }, correlationId: req.correlationId });
      const status = req.query.status as string | undefined;
      const storeId = req.query.storeId as string || "store_1";
      const limit = Math.min(parseInt(req.query.limit as string || "50", 10), 200);

      let sql = "SELECT * FROM purchase_1688 WHERE store_id = ?";
      const params: unknown[] = [storeId];
      if (status) { sql += " AND payment_status = ?"; params.push(status); }
      sql += " ORDER BY created_at DESC LIMIT ?";
      params.push(limit);

      const rows = await db.all(sql, params) as Array<Record<string, unknown>>;
      const orders = rows.map((r) => ({
        ...r,
        skuList: JSON.parse((r.sku_list_json as string) || "[]"),
        riskCheck: JSON.parse((r.risk_check_json as string) || "{}"),
      }));

      res.json({ success: true, data: orders, count: orders.length, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "PURCHASE_LIST_ERROR", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  /** POST /api/purchase/batch-pay — pay all pending orders */
  router.post("/purchase/batch-pay", async (req, res) => {
    try {
      if (!db) return res.status(503).json({ success: false, error: { code: "DB_UNAVAILABLE" }, correlationId: req.correlationId });
      const storeId = (req.body as Record<string, unknown>).storeId as string || "store_1";

      const rows = await db.all<Record<string, unknown>>(
        "SELECT * FROM purchase_1688 WHERE store_id = ? AND payment_status = 'pending' ORDER BY created_at ASC LIMIT 20",
        [storeId]
      );

      const results: Array<{ postingNumber: string; success: boolean; error?: string }> = [];
      for (const r of rows) {
        try {
          const skuList = JSON.parse((r.sku_list_json as string) || "[]");
          const input = {
            storeId: r.store_id as string,
            ozonPostingNumber: r.ozon_posting_number as string,
            ozonOrderId: r.ozon_order_id as number,
            costCny: r.total_amount_cny as number,
            sellingPriceRub: 0,
            weightKg: 0.5,
            source1688Url: r.source_1688_url as string || undefined,
            skuList,
            offerId: r.offer_id as string || undefined,
          };
          const result = await service.payOrder(input);
          results.push({ postingNumber: input.ozonPostingNumber, success: result.success, error: result.errorMsg });
        } catch (err) {
          results.push({ postingNumber: r.ozon_posting_number as string, success: false, error: (err as Error).message });
        }
      }

      res.json({ success: true, data: { processed: results.length, succeeded: results.filter((r) => r.success).length, results }, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "BATCH_PAY_ERROR", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  /** GET /api/finance/purchase-bill — daily finance bill */
  router.get("/finance/purchase-bill", async (req, res) => {
    try {
      const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);
      const bill = await service.getDailyBill(date);
      res.json({ success: true, data: bill, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "BILL_ERROR", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  /** PUT /api/purchase/:id — update payment status, logistics, etc. (for MANUAL_PAY_MODE) */
  router.put("/purchase/:id", async (req, res) => {
    try {
      if (!db) return res.status(503).json({ success: false, error: { code: "DB_UNAVAILABLE" }, correlationId: req.correlationId });

      const { id } = req.params;
      const { paymentStatus, paySerial, payTime, logisticsStatus, logisticsTracking, logisticsCarrier } = req.body as {
        paymentStatus?: string; paySerial?: string; payTime?: string;
        logisticsStatus?: string; logisticsTracking?: string; logisticsCarrier?: string;
      };

      const existing = await db.all<{ id: string; payment_status: string }>(
        "SELECT id, payment_status FROM purchase_1688 WHERE id = ?", [id]
      );
      if (existing.length === 0) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "采购单不存在" }, correlationId: req.correlationId });
      }

      // Completed orders are locked — Ozon tracking finished, no further edits allowed
      if (existing[0].payment_status === "completed") {
        return res.status(409).json({
          success: false,
          error: { code: "LOCKED", message: "该采购单已完成（Ozon物流追踪结束），不可再修改", retryable: false },
          correlationId: req.correlationId,
        });
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      if (paymentStatus !== undefined) { sets.push("payment_status = ?"); params.push(paymentStatus); }
      if (paySerial !== undefined) { sets.push("pay_serial = ?"); params.push(paySerial); }
      if (payTime !== undefined) { sets.push("pay_time = ?"); params.push(payTime); }
      if (logisticsStatus !== undefined) { sets.push("logistics_status = ?"); params.push(logisticsStatus); }
      if (logisticsTracking !== undefined) { sets.push("logistics_tracking = ?"); params.push(logisticsTracking); }
      if (logisticsCarrier !== undefined) { sets.push("logistics_carrier = ?"); params.push(logisticsCarrier); }

      if (sets.length === 0) {
        return res.status(400).json({ success: false, error: { code: "NO_FIELDS", message: "至少提供一个字段" }, correlationId: req.correlationId });
      }

      // Auto-set completed_at when marking as completed
      if (paymentStatus === "completed") {
        sets.push("completed_at = datetime('now')");
      }

      sets.push("updated_at = datetime('now')");
      params.push(id);

      await db.run(`UPDATE purchase_1688 SET ${sets.join(", ")} WHERE id = ?`, params);
      logger.info({ id, paymentStatus, logisticsStatus }, "PurchasePay: purchase order updated");

      res.json({ success: true, message: "已更新", correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "UPDATE_ERROR", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  return router;
}