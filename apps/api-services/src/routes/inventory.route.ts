import { Router } from "express";
import { InventoryManager, type InventoryItem, type SupplierInfo } from "../services/inventory-manager.js";
import { getDb } from "../db/connection.js";
import { logger } from "@onzo/logger";

export function createInventoryRouter(): Router {
  const router = Router();
  const inventoryManager = new InventoryManager();

  // ============================================================
  // Promo Agent 兼容路由
  // ============================================================

  /** GET /api/inventory — 商品列表（promoApi.products / promoApi.inventory） */
  router.get("/", async (req, res) => {
    try {
      const db = await getDb().catch(() => null);
      if (!db) { res.status(503).json({ error: "DB unavailable" }); return; }
      const limit = parseInt(String(req.query.limit || "100"), 10);

      const items = await db.all(
        `SELECT pp.product_id AS "offerId", COALESCE(pp.title, '') AS name,
                pp.sales AS orders, pp.revenue_rub AS revenue, pp.stock,
                pp.rating, pp.margin,
                0 AS cost, pp.revenue_rub AS price, pp.sales AS quantity
         FROM product_performance pp
         ORDER BY pp.revenue_rub DESC
         LIMIT ?`,
        [limit],
      );
      res.json({ items });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** GET /api/inventory/:offerId — 按 offerId 查询单个商品（promoApi.getProduct） */
  router.get("/:offerId", async (req, res) => {
    try {
      const db = await getDb().catch(() => null);
      if (!db) { res.status(503).json({ error: "DB unavailable" }); return; }
      const { offerId } = req.params;

      const rows = await db.all(
        `SELECT pp.product_id AS "offerId", COALESCE(pp.title, '') AS name,
                pp.sales AS orders, pp.revenue_rub AS revenue, pp.stock,
                pp.rating, pp.margin, pp.review_count AS "reviewCount",
                0 AS cost, pp.revenue_rub AS price
         FROM product_performance pp
         WHERE CAST(pp.product_id AS TEXT) = ?
         LIMIT 1`,
        [offerId],
      );

      if (rows.length === 0) {
        res.status(404).json({ error: "Product not found", offerId });
        return;
      }
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** PUT /api/inventory/:offerId/price — 更新价格 + 审计（promoApi.updatePrice） */
  router.put("/:offerId/price", async (req, res) => {
    try {
      const db = await getDb().catch(() => null);
      if (!db) { res.status(503).json({ error: "DB unavailable" }); return; }
      const { offerId } = req.params;
      const { price } = req.body as { price?: number };

      if (typeof price !== "number" || price <= 0) {
        res.status(400).json({ error: "Valid price > 0 is required" });
        return;
      }

      // 查询旧价格
      const rows = await db.all(
        `SELECT revenue_rub AS "oldPrice", title AS name
         FROM product_performance WHERE CAST(product_id AS TEXT) = ? LIMIT 1`,
        [offerId],
      );
      const oldPrice = (rows[0] as Record<string, unknown> | undefined)?.oldPrice as number || 0;
      const name = (rows[0] as Record<string, unknown> | undefined)?.name as string || "";

      // 验证调价幅度（≤20%）
      if (oldPrice > 0) {
        const diffPct = Math.abs((price - oldPrice) / oldPrice);
        if (diffPct > 0.20) {
          logger.warn({ offerId, oldPrice, newPrice: price, diffPct }, "Price change exceeds 20% limit");
        }
      }

      // 更新 product_performance 表价格
      await db.run(
        `UPDATE product_performance SET revenue_rub = ?, updated_at = NOW()
         WHERE CAST(product_id AS TEXT) = ?`,
        [price, offerId],
      );

      // 写入审计记录
      try {
        await db.run(
          `INSERT INTO promo_pricing_history (offer_id, name, old_price, new_price, reason)
           VALUES (?, ?, ?, ?, ?)`,
          [offerId, name, oldPrice, price, "promo-agent auto"],
        );
      } catch (auditErr) {
        logger.warn({ auditErr }, "Failed to write pricing audit record");
      }

      logger.info({ offerId, oldPrice, newPrice: price }, "Price updated");
      res.json({ success: true, offerId, oldPrice, newPrice: price });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** PUT /api/inventory/:offerId — 更新商品信息（promoApi.updateProduct） */
  router.put("/:offerId", async (req, res) => {
    try {
      const db = await getDb().catch(() => null);
      if (!db) { res.status(503).json({ error: "DB unavailable" }); return; }
      const { offerId } = req.params;
      const { name, description } = req.body as { name?: string; description?: string };

      if (!name && !description) {
        res.status(400).json({ error: "name or description is required" });
        return;
      }

      // 更新 product_performance 表
      const updates: string[] = [];
      const params: unknown[] = [];

      if (name) {
        updates.push("title = ?");
        params.push(name);
      }
      if (description) {
        // product_performance 没有 description 字段，写审计日志代替
        logger.info({ offerId, description: description.slice(0, 200) }, "Product description update (logged only)");
      }

      if (updates.length > 0) {
        updates.push("updated_at = NOW()");
        params.push(offerId);
        await db.run(
          `UPDATE product_performance SET ${updates.join(", ")} WHERE CAST(product_id AS TEXT) = ?`,
          params,
        );
      }

      // 写入文案历史
      if (name) {
        try {
          await db.run(
            `INSERT INTO promo_copy_history (offer_id, name, title_ru) VALUES (?, ?, ?)`,
            [offerId, name, description || ""],
          );
        } catch (auditErr) {
          logger.warn({ auditErr }, "Failed to write copy audit record");
        }
      }

      res.json({ success: true, offerId, updated: { name, description: description?.slice(0, 100) } });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ============================================================
  // 原有路由
  // ============================================================

  router.post("/items", async (req, res) => {
    try {
      const items = req.body as InventoryItem[];
      items.forEach(item => inventoryManager.addItem(item));
      
      res.json({
        success: true,
        message: `成功添加 ${items.length} 个库存项`,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "INVENTORY_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.get("/items/:offerId/:sku", async (req, res) => {
    try {
      const { offerId, sku } = req.params;
      const item = inventoryManager.getItem(offerId, parseInt(sku));
      
      if (!item) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "库存项不存在", retryable: false },
          correlationId: req.correlationId
        });
      }
      
      res.json({
        success: true,
        data: item,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "INVENTORY_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.put("/items/:offerId/:sku/stock", async (req, res) => {
    try {
      const { offerId, sku } = req.params;
      const { delta } = req.body as { delta: number };
      
      inventoryManager.updateStock(offerId, parseInt(sku), delta);
      
      res.json({
        success: true,
        message: `库存已更新，变更量: ${delta}`,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "INVENTORY_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.post("/items/:offerId/:sku/reserve", async (req, res) => {
    try {
      const { offerId, sku } = req.params;
      const { quantity } = req.body as { quantity: number };
      
      const success = inventoryManager.reserveStock(offerId, parseInt(sku), quantity);
      
      if (!success) {
        return res.status(400).json({
          success: false,
          error: { code: "INSUFFICIENT_STOCK", message: "库存不足", retryable: false },
          correlationId: req.correlationId
        });
      }
      
      res.json({
        success: true,
        message: `已预留 ${quantity} 件库存`,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "INVENTORY_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.post("/items/:offerId/:sku/release", async (req, res) => {
    try {
      const { offerId, sku } = req.params;
      const { quantity } = req.body as { quantity: number };
      
      inventoryManager.releaseStock(offerId, parseInt(sku), quantity);
      
      res.json({
        success: true,
        message: `已释放 ${quantity} 件预留库存`,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "INVENTORY_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.post("/suppliers", async (req, res) => {
    try {
      const suppliers = req.body as SupplierInfo[];
      suppliers.forEach(supplier => inventoryManager.addSupplier(supplier));
      
      res.json({
        success: true,
        message: `成功添加 ${suppliers.length} 个供应商`,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "INVENTORY_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.get("/suppliers", async (req, res) => {
    try {
      const suppliers = inventoryManager.getSuppliers();
      
      res.json({
        success: true,
        data: suppliers,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "INVENTORY_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.get("/alerts", async (req, res) => {
    try {
      const alerts = await inventoryManager.getAlerts();

      res.json({
        success: true,
        data: alerts,
        count: alerts.length,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "INVENTORY_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.get("/recommendations", async (req, res) => {
    try {
      const recommendations = await inventoryManager.getReorderRecommendations();
      
      res.json({
        success: true,
        data: recommendations,
        count: recommendations.length,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "INVENTORY_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.get("/value", async (req, res) => {
    try {
      const value = inventoryManager.getInventoryValue();
      
      res.json({
        success: true,
        data: value,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "INVENTORY_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  return router;
}