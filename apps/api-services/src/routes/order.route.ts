// ============================================================
// Order sync routes — Ozon FBO/FBS order listing and status sync
// ============================================================

import { Router } from "express";
import { OzonOrderClient } from "@onzo/ozon-order";
import { getDb } from "../db/connection.js";
import type { LocalOrder, OzonPosting } from "@onzo/shared-types";
import type { OzonClient } from "@onzo/ozon-api-wrapper";

export function createOrderRouter(ozonClient: OzonClient): Router {
  const router = Router();
  const orderClient = new OzonOrderClient(ozonClient);

  // POST /api/orders/sync — pull orders from Ozon and store locally
  router.post("/orders/sync", async (req, res) => {
    const { status, since, until } = req.body as { status?: string; since?: string; until?: string };

    try {
      const [fbsOrders, fboOrders] = await Promise.all([
        orderClient.listPostings({ status: status as any, since, until, limit: 50 }),
        orderClient.listFboPostings({ status: status as any, since, until, limit: 50 }).catch(() => [] as OzonPosting[]),
      ]);

      const allOrders = [...fbsOrders, ...fboOrders];
      const db = await getDb();

      let upserted = 0;
      for (const order of allOrders) {
        if (!db) break;
        const local: LocalOrder = {
          id: order.postingNumber,
          postingNumber: order.postingNumber,
          orderId: order.orderId,
          status: order.status,
          createdAt: order.createdAt,
          updatedAt: new Date().toISOString(),
          buyerNameMasked: order.buyerName,
          buyerPhoneMasked: order.buyerPhone,
          totalPriceRub: order.price,
          commissionRub: order.commission,
          payoutRub: order.payout,
          productCount: order.products.length,
          trackingNumber: order.trackingNumber,
          rawJson: JSON.stringify(order),
        };

        await db.run(
          `INSERT OR REPLACE INTO local_orders
           (id, posting_number, order_id, status, created_at, updated_at, buyer_name_masked,
            buyer_phone_masked, total_price_rub, commission_rub, payout_rub,
            product_count, tracking_number, raw_json, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
          [local.id, local.postingNumber, local.orderId, local.status,
           local.createdAt, local.updatedAt, local.buyerNameMasked,
           local.buyerPhoneMasked, local.totalPriceRub, local.commissionRub,
           local.payoutRub, local.productCount, local.trackingNumber ?? null, local.rawJson]
        ).catch(() => {});
        upserted++;
      }

      res.json({
        success: true,
        data: { fbs: fbsOrders.length, fbo: fboOrders.length, upserted },
        correlationId: req.correlationId,
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "ORDER_SYNC_FAILED", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId,
      });
    }
  });

  // GET /api/orders — list locally synced orders
  router.get("/orders", async (req, res) => {
    try {
      const db = await getDb();
      if (!db) {
        res.json({ success: true, data: [], correlationId: req.correlationId });
        return;
      }
      const status = req.query.status as string | undefined;
      const sql = status
        ? "SELECT * FROM local_orders WHERE status = ? ORDER BY created_at DESC LIMIT 100"
        : "SELECT * FROM local_orders ORDER BY created_at DESC LIMIT 100";
      const params = status ? [status] : [];

      const rows = await db.all(sql, params);
      res.json({ success: true, data: rows, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "DB_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId,
      });
    }
  });

  // POST /api/orders/ship — mark FBS order as shipped
  router.post("/orders/ship", async (req, res) => {
    const { postingNumber, trackingNumber, products } = req.body as {
      postingNumber: string; trackingNumber: string; products: Array<{ sku: number; quantity: number }>;
    };

    try {
      await orderClient.shipOrder(postingNumber, trackingNumber, products);
      res.json({ success: true, data: { postingNumber, status: "shipped" }, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "SHIP_FAILED", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId,
      });
    }
  });

  return router;
}
