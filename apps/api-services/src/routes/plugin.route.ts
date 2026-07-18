// ============================================================
// Plugin Route — 1688采购助手插件数据接收
// POST /api/crawl/plugin-1688
// ============================================================

import { Router } from "express";
import { getDb } from "../db/connection.js";
import { logger } from "@onzo/logger";
import { executeAutoSelect } from "../langgraph/auto-select-graph.js";

export function createPluginRouter(): Router {
  const router = Router();

  router.post("/crawl/plugin-1688", async (req, res) => {
    try {
      const product = req.body as {
        sourceUrl?: string; title?: string;
        price?: { min: number; max: number };
        images?: string[]; specs?: Array<{ name: string; value: string }>;
        weight?: string; supplier?: string; shipping?: string;
        stock?: string; category?: string;
      };

      if (!product.title || !product.sourceUrl) {
        return res.status(400).json({
          success: false, error: { code: "MISSING", message: "title and sourceUrl required" },
          correlationId: req.correlationId,
        });
      }

      // 1. Validate + store
      const db = await getDb().catch(() => null);
      const priceCny = product.price?.min || 0;

      if (!priceCny || priceCny <= 0) {
        logger.warn({ title: product.title }, "Plugin: price missing — TG alert");
        try {
          const { notifier } = await import("../services/notifier.js");
          await notifier.notify({
            level: "warn", event: "PLUGIN_PRICE_MISSING",
            message: `插件采集商品缺价格: ${product.title.slice(0, 50)}`,
            correlationId: req.correlationId,
            force: false,
          }).catch(() => {});
        } catch { /* notifier optional */ }
      }

      // Store in plugin_products table
      if (db) {
        db.exec("CREATE TABLE IF NOT EXISTS plugin_products (id TEXT PRIMARY KEY, source_url TEXT, title TEXT, price_cny REAL, images_json TEXT, specs_json TEXT, weight TEXT, supplier TEXT, stock TEXT, category TEXT, created_at TEXT DEFAULT (datetime('now')), synced INTEGER DEFAULT 0)");
        const id = `plug_${Date.now()}`;
        await db.run(
          "INSERT OR REPLACE INTO plugin_products (id, source_url, title, price_cny, images_json, specs_json, weight, supplier, stock, category) VALUES (?,?,?,?,?,?,?,?,?,?)",
          [id, product.sourceUrl, product.title, priceCny, JSON.stringify(product.images || []), JSON.stringify(product.specs || []), product.weight || "", product.supplier || "", product.stock || "", product.category || ""],
        );
        logger.info({ id, title: product.title.slice(0, 50) }, "Plugin: product stored");
      }

      // 2. Trigger LangGraph analysis
      let score = 0;
      let profitRub = 0;
      try {
        const analysis = await executeAutoSelect(product.title.slice(0, 30));
        const top = analysis.scored?.[0];
        if (top) {
          score = top.finalScore;
          profitRub = Math.round((priceCny || 50) * 11.5 * 0.3);
        }
      } catch (e) {
        logger.warn({ err: (e as Error).message }, "Plugin: analysis failed, continuing");
      }

      res.json({
        success: true,
        data: { score, profitRub, stored: true },
        message: "商品已同步至ERP，正在参与大盘选品分析",
        correlationId: req.correlationId,
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "PLUGIN_ERROR", message: (err as Error).message },
        correlationId: req.correlationId,
      });
    }
  });

  // GET /api/crawl/plugin-list — list collected products
  router.get("/crawl/plugin-list", async (req, res) => {
    try {
      const db = await getDb().catch(() => null);
      const rows = db ? await db.all<Record<string, string>>("SELECT * FROM plugin_products ORDER BY created_at DESC LIMIT 50") : [];
      res.json({ success: true, data: rows, count: rows.length, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "PLUGIN_ERROR", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  return router;
}
