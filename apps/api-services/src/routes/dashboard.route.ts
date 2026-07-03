// ============================================================
// Dashboard — minimal JSON API for ops overview
// Designed for n8n or curl consumption, no frontend framework
// ============================================================

import { Router } from "express";
import { getDb } from "../db/connection.js";
import type { TaskQueue } from "../db/task-queue.js";

export function createDashboardRouter(taskQueue: TaskQueue): Router {
  const router = Router();

  // GET /api/dashboard — single JSON with all key metrics
  router.get("/dashboard", async (req, res) => {
    const db = await getDb().catch(() => null);
    const queueStats = taskQueue.getStats();

    let todayListings = 0;
    let todayTokens = 0;
    let pendingOrders = 0;
    let lowStockProducts = 0;

    if (db) {
      const today = new Date().toISOString().split("T")[0];

      const listingRows = await db.all(
        "SELECT COUNT(*) as cnt FROM listing_records WHERE date(created_at) = ?",
        [today]
      ) as Array<{ cnt: number }>;
      todayListings = listingRows[0]?.cnt ?? 0;

      const tokenRows = await db.all(
        "SELECT COALESCE(SUM(total_tokens), 0) as total FROM token_usage WHERE date(timestamp) = ?",
        [today]
      ) as Array<{ total: number }>;
      todayTokens = tokenRows[0]?.total ?? 0;

      const orderRows = await db.all(
        "SELECT COUNT(*) as cnt FROM local_orders WHERE status IN ('awaiting_packaging','awaiting_deliver','delivering')"
      ) as Array<{ cnt: number }>;
      pendingOrders = orderRows[0]?.cnt ?? 0;

      const stockRows = await db.all(
        "SELECT COUNT(*) as cnt FROM inventory WHERE stock_available < 5"
      ) as Array<{ cnt: number }>;
      lowStockProducts = stockRows[0]?.cnt ?? 0;
    }

    res.json({
      success: true,
      data: {
        queue: queueStats,
        todayListings,
        todayTokens,
        pendingOrders,
        lowStockProducts,
        timestamp: new Date().toISOString(),
      },
      correlationId: req.correlationId,
    });
  });

  return router;
}
