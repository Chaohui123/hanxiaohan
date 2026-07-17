// ============================================================
// Store Admin — proxy isolation, per-store queue, global summary
// ============================================================

import { Router } from "express";
import { getDb } from "../db/connection.js";

export function createStoreAdminRouter(): Router {
  const router = Router();

  // GET /api/stores/summary — global cross-store summary
  router.get("/stores/summary", async (req, res) => {
    try {
      const db = await getDb();
      if (!db) { res.status(503).json({ success: false }); return; }

      const stores = await db.all<Record<string, unknown>>("SELECT COUNT(*) as total, SUM(active) as active FROM store_configs");
      const groups = await db.all<Record<string, unknown>>("SELECT COUNT(DISTINCT group_name) as cnt FROM store_configs WHERE group_name IS NOT NULL");
      const listings = await db.all<Record<string, unknown>>("SELECT COUNT(*) as total FROM listing_records WHERE date(created_at) = CURRENT_DATE");
      const orders = await db.all<Record<string, unknown>>("SELECT COUNT(*) as pending FROM local_orders WHERE status IN ('awaiting_packaging','awaiting_deliver','delivering')");
      const tokens = await db.all<Record<string, unknown>>("SELECT COALESCE(SUM(total_tokens),0) as total FROM token_usage WHERE date(timestamp) = CURRENT_DATE");
      const lowStock = await db.all<Record<string, unknown>>("SELECT COUNT(*) as cnt FROM inventory WHERE stock_available < 5");

      // Per-store breakdown with correlated listing count
      const perStore = await db.all<Record<string, unknown>>(
        "SELECT s.store_id, s.store_name, s.group_name, s.proxy_url, s.active," +
        " (SELECT COUNT(*) FROM task_queue t WHERE t.store_id = s.store_id AND t.status IN ('queued','processing')) as activeTasks," +
        " (SELECT COUNT(*) FROM task_queue t WHERE t.store_id = s.store_id AND t.status = 'failed') as failedTasks" +
        " FROM store_configs s WHERE s.active = 1 ORDER BY s.group_name, s.store_id"
      );

      res.json({
        success: true,
        data: {
          totals: {
            stores: stores[0]?.total ?? 0,
            activeStores: stores[0]?.active ?? 0,
            groups: groups[0]?.cnt ?? 0,
            todayListings: listings[0]?.total ?? 0,
            pendingOrders: orders[0]?.pending ?? 0,
            todayTokens: tokens[0]?.total ?? 0,
            lowStockProducts: lowStock[0]?.cnt ?? 0,
          },
          perStore,
        },
        correlationId: req.correlationId,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "SUMMARY_FAILED", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  // POST /api/stores/:storeId/proxy — update proxy for a store
  router.post("/stores/:storeId/proxy", async (req, res) => {
    const { proxyUrl } = req.body as { proxyUrl: string };
    try {
      const db = await getDb();
      if (!db) { res.status(503).json({ success: false }); return; }

      await db.run("UPDATE store_configs SET proxy_url = ? WHERE store_id = ?", [proxyUrl || null, req.params.storeId]);
      res.json({ success: true, data: { storeId: req.params.storeId, proxyUrl }, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "PROXY_UPDATE_FAILED", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  // GET /api/stores/:storeId/queue — per-store task queue stats
  router.get("/stores/:storeId/queue", async (req, res) => {
    try {
      const db = await getDb();
      if (!db) { res.status(503).json({ success: false }); return; }

      const stats = await db.all<Record<string, unknown>>(
        "SELECT status, COUNT(*) as cnt FROM task_queue WHERE store_id = ? GROUP BY status",
        [req.params.storeId]
      );

      res.json({ success: true, data: { storeId: req.params.storeId, stats }, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "QUEUE_STATS_FAILED", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  // POST /api/stores/batch/sync-orders — sync orders across multiple stores
  router.post("/stores/batch/sync-orders", async (req, res) => {
    const { storeIds, groupName } = req.body as { storeIds?: string[]; groupName?: string };

    try {
      const db = await getDb();
      if (!db) { res.status(503).json({ success: false }); return; }

      let stores: Array<Record<string, unknown>>;
      if (groupName) {
        stores = await db.all("SELECT store_id FROM store_configs WHERE group_name = ? AND active = 1", [groupName]);
      } else if (storeIds?.length) {
        const placeholders = storeIds.map(() => "?").join(",");
        stores = await db.all(`SELECT store_id FROM store_configs WHERE store_id IN (${placeholders}) AND active = 1`, storeIds);
      } else {
        stores = await db.all("SELECT store_id FROM store_configs WHERE active = 1");
      }

      const results: Array<{ storeId: string; status: string }> = [];
      for (const s of stores) {
        // Each store sync runs independently — staggered by n8n
        results.push({ storeId: s.store_id as string, status: "queued" });
      }

      res.json({
        success: true,
        data: { stores: results.length, results },
        message: "Batch order sync queued. n8n will stagger execution per group.",
        correlationId: req.correlationId,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "BATCH_SYNC_FAILED", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  // GET /api/stores/fx — current CNY→RUB exchange rate
  router.get("/stores/fx", async (_req, res) => {
    const { getExchangeRate } = await import("../services/exchange-rate.js");
    const fx = await getExchangeRate();
    res.json({ success: true, data: fx, correlationId: (_req as unknown as Record<string,string>).correlationId });
  });

  return router;
}
