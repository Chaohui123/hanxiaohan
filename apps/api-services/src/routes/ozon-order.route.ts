// ============================================================
// Ozon Order Sync v2 Routes — manual sync trigger + list
// ============================================================

import { Router } from "express";
import type { OzonClient } from "@onzo/ozon-api-wrapper";
import type { DbAdapter } from "../db/connection.js";
import { OzonOrderSyncService } from "../services/ozon-order-sync.js";
import { emitEvent, EVENT_KEYS } from "../services/notification-events.js";
import { logger } from "@onzo/logger";

export function createOzonOrderRouter(db: DbAdapter | null, _ozonClient: OzonClient): Router {
  const router = Router();

  /** POST /api/ozon/orders/sync — manually trigger order sync */
  router.post("/ozon/orders/sync", async (req, res) => {
    const startTime = Date.now();
    try {
      const storeId = (req.query.storeId as string) || undefined;
      const service = new OzonOrderSyncService(db);

      let result;
      if (storeId) {
        // Sync single store
        const stores = await import("../db/models.js").then((m) => m.getActiveStoreConfigs());
        const store = stores.find((s) => s.storeId === storeId);
        if (!store) {
          return res.status(404).json({
            success: false,
            error: { code: "STORE_NOT_FOUND", message: `店铺 ${storeId} 不存在或未激活`, retryable: false },
            correlationId: req.correlationId,
          });
        }
        const storeResult = await service.syncStore(storeId, store.clientId, store.apiKey);
        result = {
          storesScanned: 1,
          totalOrders: storeResult.newOrders + storeResult.skippedOrders,
          newOrders: storeResult.newOrders,
          flaggedOrders: storeResult.flaggedOrders,
          skippedOrders: storeResult.skippedOrders,
          errors: storeResult.errors,
        };
      } else {
        result = await service.syncAllStores();
      }

      const durationMs = Date.now() - startTime;
      logger.info({ ...result, durationMs }, "OzonOrderSync: Manual sync completed");

      if (result.errors.length > 0) {
        await emitEvent(EVENT_KEYS.ORDER_SYNC_FAILED, {
          error: result.errors.slice(0, 3).join("; "),
          storeCount: String(result.storesScanned),
        }, req.correlationId as string);
      }

      res.json({ success: true, data: { ...result, durationMs }, correlationId: req.correlationId });
    } catch (err) {
      const message = (err as Error).message;
      logger.error({ err: message }, "OzonOrderSync: Manual sync failed");
      await emitEvent(EVENT_KEYS.ORDER_SYNC_FAILED, {
        error: message,
        storeCount: "0",
      }, req.correlationId as string);

      res.status(500).json({
        success: false,
        error: { code: "OZON_ORDER_SYNC_FAILED", message, retryable: true },
        correlationId: req.correlationId,
      });
    }
  });

  /** GET /api/ozon/orders — list enriched orders */
  router.get("/ozon/orders", async (req, res) => {
    try {
      if (!db) {
        return res.status(503).json({
          success: false,
          error: { code: "DB_UNAVAILABLE", message: "数据库不可用", retryable: true },
          correlationId: req.correlationId,
        });
      }

      const storeId = (req.query.storeId as string) || "store_1";
      const status = req.query.status as string | undefined;
      const limit = Math.min(parseInt(req.query.limit as string || "50", 10), 200);

      let sql = "SELECT * FROM ozon_orders WHERE store_id = ?";
      const params: unknown[] = [storeId];
      if (status) { sql += " AND status = ?"; params.push(status); }
      sql += " ORDER BY synced_at DESC LIMIT ?";
      params.push(limit);

      const rows = await db.all(sql, params) as Array<Record<string, unknown>>;

      // Parse products_json for each row
      const orders = rows.map((r) => ({
        ...r,
        products: JSON.parse((r.products_json as string) || "[]"),
      }));

      res.json({ success: true, data: orders, count: orders.length, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "OZON_ORDER_LIST_FAILED", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId,
      });
    }
  });

  /** GET /api/ozon/orders/flagged — orders needing manual review */
  router.get("/ozon/orders/flagged", async (req, res) => {
    try {
      if (!db) {
        return res.status(503).json({
          success: false,
          error: { code: "DB_UNAVAILABLE", message: "数据库不可用", retryable: true },
          correlationId: req.correlationId,
        });
      }

      const storeId = (req.query.storeId as string) || "store_1";
      const rows = await db.all(
        "SELECT * FROM ozon_orders WHERE store_id = ? AND needs_review = 1 ORDER BY synced_at DESC LIMIT 100",
        [storeId]
      ) as Array<Record<string, unknown>>;

      const orders = rows.map((r) => ({
        ...r,
        products: JSON.parse((r.products_json as string) || "[]"),
      }));

      res.json({ success: true, data: orders, count: orders.length, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "OZON_ORDER_FLAGGED_FAILED", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId,
      });
    }
  });

  return router;
}
