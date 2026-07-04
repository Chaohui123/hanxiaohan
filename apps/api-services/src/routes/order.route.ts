// ============================================================
// Order sync routes — Ozon FBO/FBS order listing and status sync
// ============================================================

import { Router } from "express";
import { OzonOrderClient, syncOrders } from "@onzo/ozon-order";
import { validateBody } from "../middleware/validate.js";
import { getDb } from "../db/connection.js";
import type { LocalOrder, OzonPosting, OzonOrderStatus } from "@onzo/shared-types";
import type { OzonClient } from "@onzo/ozon-api-wrapper";
import { AuthManager } from "@onzo/ozon-api-wrapper";

export function createOrderRouter(ozonClient: OzonClient): Router {
  const router = Router();
  const orderClient = new OzonOrderClient(ozonClient);

  // POST /api/orders/sync — pull orders from Ozon and store locally
  router.post("/orders/sync", async (req, res) => {
    const { status, since, until, storeId } = req.body as { status?: string; since?: string; until?: string; storeId?: string };

    const validStatuses: OzonOrderStatus[] = ["awaiting_packaging", "awaiting_deliver", "delivering", "delivered", "cancelled"];
    const orderStatus: OzonOrderStatus | undefined = validStatuses.includes(status as OzonOrderStatus)
      ? (status as OzonOrderStatus) : undefined;

    const syncStoreId = storeId ?? "store_1";
    const db = await getDb();

    // Resolve store proxy for multi-store IP isolation
    if (storeId) {
      try {
        const cfg = await db?.all("SELECT proxy_url FROM store_configs WHERE store_id=? AND active=1", [storeId]) as Array<Record<string,string>>;
        if (cfg?.[0]?.proxy_url) process.env.HTTP_PROXY = cfg[0].proxy_url;
      } catch { /* optional */ }
    }

    if (!db) {
      res.status(503).json({
        success: false,
        error: { code: "DB_UNAVAILABLE", message: "Database unavailable", retryable: true },
        correlationId: req.correlationId,
      });
      return;
    }

    try {
      const storeConfigRow = await db.all("SELECT client_id, api_key FROM store_configs WHERE store_id = ? AND active = 1 LIMIT 1", [syncStoreId]);
      const storeCreds = storeConfigRow?.[0] as { client_id?: string; api_key?: string } | undefined;
      const effectiveClient = storeCreds?.client_id && storeCreds?.api_key
        ? new OzonOrderClient(new OzonClient({
            auth: new AuthManager({ clients: [{ clientId: storeCreds.client_id, apiKey: storeCreds.api_key, storeId: syncStoreId }] }),
            baseUrl: (ozonClient as unknown as { baseUrl?: string }).baseUrl,
          }))
        : orderClient;

      const result = await syncOrders(ozonClient, {
        client: effectiveClient,
        db,
        storeId: syncStoreId,
        status: orderStatus ? orderStatus : undefined,
        since,
        until,
        pageSize: parseInt(process.env.ORDER_SYNC_PAGE_SIZE || "50", 10),
        processPosting: async (order, ctx) => {
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
             (id, store_id, posting_number, order_id, status, created_at, updated_at, buyer_name_masked,
              buyer_phone_masked, total_price_rub, commission_rub, payout_rub,
              product_count, tracking_number, raw_json, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
            [local.id, syncStoreId, local.postingNumber, local.orderId, local.status,
             local.createdAt, local.updatedAt, local.buyerNameMasked,
             local.buyerPhoneMasked, local.totalPriceRub, local.commissionRub,
             local.payoutRub, local.productCount, local.trackingNumber ?? null, local.rawJson]
          );
        },
      });

      res.json({
        success: true,
        data: { fbs: result.fbsCount, fbo: result.fboCount, upserted: result.upserted, skipped: result.total - result.upserted },
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
  router.post("/orders/ship",
    validateBody([
      { field: "postingNumber", type: "string", required: true },
      { field: "trackingNumber", type: "string", required: true },
      { field: "products", type: "array", required: true, min: 1 },
    ]),
    async (req, res) => {
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
