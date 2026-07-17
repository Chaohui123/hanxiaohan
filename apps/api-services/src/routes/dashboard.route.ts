// ============================================================
// Dashboard v2 — Redis-cached multi-store stats, COS, task monitor
// ============================================================

import { Router } from "express";
import { getDb } from "../db/connection.js";
import type { TaskQueue } from "../db/task-queue.js";
import { cache, TTL } from "@onzo/cache";

export function createDashboardRouter(taskQueue: TaskQueue): Router {
  const router = Router();

  /** GET /api/dashboard — Redis-cached key metrics */
  router.get("/dashboard", async (req, res) => {
    try {
      const data = await cache.cachedGetOrSet("dashboard", "stats", TTL.DASHBOARD_STATS, async () => {
        const db = await getDb().catch(() => null);
        const queueStats = taskQueue.getStats();
        const today = new Date().toISOString().split("T")[0];

        let todayListings = 0, todayTokens = 0, pendingOrders = 0, lowStockProducts = 0, totalInventory = 0;

        if (db) {
          const [lr, tr, or2, sr, inv] = await Promise.all([
            db.all("SELECT COUNT(*) as cnt FROM listing_records WHERE date(created_at) = ?", [today]) as Promise<Array<{ cnt: number }>>,
            db.all("SELECT COALESCE(SUM(total_tokens), 0) as total FROM token_usage WHERE date(timestamp) = ?", [today]) as Promise<Array<{ total: number }>>,
            db.all("SELECT COUNT(*) as cnt FROM local_orders WHERE status IN ('awaiting_packaging','awaiting_deliver','delivering')") as Promise<Array<{ cnt: number }>>,
            db.all("SELECT COUNT(*) as cnt FROM inventory WHERE stock_available < 5") as Promise<Array<{ cnt: number }>>,
            db.all("SELECT COALESCE(SUM(stock_available), 0) as total FROM inventory") as Promise<Array<{ total: number }>>,
          ]);
          todayListings = lr[0]?.cnt ?? 0;
          todayTokens = tr[0]?.total ?? 0;
          pendingOrders = or2[0]?.cnt ?? 0;
          lowStockProducts = sr[0]?.cnt ?? 0;
          totalInventory = inv[0]?.total ?? 0;
        }

        return { queue: queueStats, todayListings, todayTokens, pendingOrders, lowStockProducts, totalInventory, timestamp: new Date().toISOString() };
      });

      res.json({ success: true, data, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "DASHBOARD_ERROR", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  /** GET /api/dashboard/global — multi-store aggregated stats */
  router.get("/dashboard/global", async (req, res) => {
    try {
      const data = await cache.cachedGetOrSet("dashboard", "global", 60, async () => {
        const db = await getDb().catch(() => null);
        if (!db) return { stores: 0, totalListings: 0, totalOrders: 0, totalInventory: 0, totalTokens: 0 };

        const stores = await db.all("SELECT COUNT(*) as cnt FROM store_configs WHERE active = 1") as Array<{ cnt: number }>;
        const listings = await db.all("SELECT COUNT(*) as cnt FROM listing_records") as Array<{ cnt: number }>;
        const orders = await db.all("SELECT COUNT(*) as cnt FROM local_orders") as Array<{ cnt: number }>;
        const inventory = await db.all("SELECT COALESCE(SUM(stock_available),0) as total FROM inventory") as Array<{ total: number }>;
        const tokens = await db.all("SELECT COALESCE(SUM(total_tokens),0) as total FROM token_usage") as Array<{ total: number }>;

        return {
          stores: stores[0]?.cnt ?? 0,
          totalListings: listings[0]?.cnt ?? 0,
          totalOrders: orders[0]?.cnt ?? 0,
          totalInventory: inventory[0]?.total ?? 0,
          totalTokens: tokens[0]?.total ?? 0,
          timestamp: new Date().toISOString(),
        };
      });

      res.json({ success: true, data, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "GLOBAL_DASHBOARD_ERROR", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  /** GET /api/dashboard/alerts — active alerts: stock, token, rate-limit */
  router.get("/dashboard/alerts", async (_req, res) => {
    try {
      const db = await getDb().catch(() => null);
      const alerts: Array<{ type: string; level: string; message: string; count: number }> = [];

      if (db) {
        const stockOut = await db.all("SELECT COUNT(*) as cnt FROM inventory WHERE stock_available = 0") as Array<{ cnt: number }>;
        if (stockOut[0]?.cnt > 0) alerts.push({ type: "stock_out", level: "critical", message: `${stockOut[0].cnt} 个SKU库存为零`, count: stockOut[0].cnt });

        const stockLow = await db.all("SELECT COUNT(*) as cnt FROM inventory WHERE stock_available > 0 AND stock_available < 5") as Array<{ cnt: number }>;
        if (stockLow[0]?.cnt > 0) alerts.push({ type: "stock_low", level: "warning", message: `${stockLow[0].cnt} 个SKU库存不足`, count: stockLow[0].cnt });

        const failedTasks = await db.all("SELECT COUNT(*) as cnt FROM failed_tasks WHERE status = 'pending_retry'") as Array<{ cnt: number }>;
        if (failedTasks[0]?.cnt > 0) alerts.push({ type: "failed_tasks", level: "warning", message: `${failedTasks[0].cnt} 个失败任务待处理`, count: failedTasks[0].cnt });
      }

      // Token usage alert
      const today = new Date().toISOString().split("T")[0];
      const tokenKey = `onzo:daily:tokens:${today}`;
      const tokenCount = await cache.counterGet("daily", "tokens");
      const tokenLimit = parseInt(process.env.LLM_DAILY_TOKEN_LIMIT || "0", 10);
      if (tokenLimit > 0 && tokenCount > tokenLimit * 0.8) {
        alerts.push({ type: "token_limit", level: tokenCount >= tokenLimit ? "critical" : "warning", message: `Token用量 ${tokenCount}/${tokenLimit}`, count: tokenCount });
      }

      res.json({ success: true, data: alerts, correlationId: _req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "ALERTS_ERROR", message: (err as Error).message }, correlationId: _req.correlationId });
    }
  });

  /** GET /api/dashboard/cos — COS storage stats */
  router.get("/dashboard/cos", async (_req, res) => {
    try {
      const db = await getDb().catch(() => null);
      if (!db) return res.json({ success: true, data: { totalImages: 0, deadLetter: 0, usagePercent: 0 }, correlationId: _req.correlationId });

      const [img, dl] = await Promise.all([
        db.all("SELECT COUNT(*) as cnt FROM images") as Promise<Array<{ cnt: number }>>,
        db.all("SELECT COUNT(*) as cnt FROM images WHERE dead_letter = 1 OR status = 'failed'") as Promise<Array<{ cnt: number }>>,
      ]);

      const totalImages = img[0]?.cnt ?? 0;
      const deadLetter = dl[0]?.cnt ?? 0;
      // Rough estimate: each image ~500KB, COS free tier usually 10GB
      const estimatedBytes = totalImages * 500 * 1024;
      const usagePercent = Math.min(100, Math.round((estimatedBytes / (10 * 1024 * 1024 * 1024)) * 100));

      res.json({ success: true, data: { totalImages, deadLetter, estimatedBytes, usagePercent, freeTierGB: 10 }, correlationId: _req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "COS_ERROR", message: (err as Error).message } });
    }
  });

  /** GET /api/dashboard/tasks — Ozon import task monitor */
  router.get("/dashboard/tasks", async (req, res) => {
    try {
      const status = (req.query.status as string) || "all";
      const limit = Math.min(parseInt(req.query.limit as string || "50", 10), 200);

      let sql = "SELECT * FROM task_queue";
      const params: unknown[] = [];
      if (status !== "all") { sql += " WHERE status = ?"; params.push(status); }
      sql += " ORDER BY created_at DESC LIMIT ?";
      params.push(limit);

      const db = await getDb().catch(() => null);
      const rows = db ? await db.all(sql, params) as Array<Record<string, unknown>> : [];

      res.json({ success: true, data: rows, count: rows.length, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "TASKS_ERROR", message: (err as Error).message } });
    }
  });

  return router;
}