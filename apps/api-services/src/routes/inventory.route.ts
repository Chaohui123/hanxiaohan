import { Router } from "express";
import { InventoryManager, type InventoryItem, type SupplierInfo } from "../services/inventory-manager.js";
import { getDb } from "../db/connection.js";
import { getActiveStoreConfigs } from "../db/models.js";
import { decrypt, isEncrypted } from "../services/crypto.js";
import { logger } from "@onzo/logger";

// ============================================================
// Ozon 实时商品 fallback
// product_performance 为空时，从 Ozon Seller API 拉在售商品，
// 合成 promo-agent 契约字段（price=RUB 售价，cost=CNY 采购成本）
// ============================================================

interface OzonInventoryItem {
  offerId: string;
  name: string;
  price: number;
  stock: number;
  cost: number;
  weight: number; // kg（sku_1688_mapping.weight_kg）
  rating: number;
  orders: number;
  revenue: number;
  quantity: number;
}

// 90s 轻量内存缓存，避免 decision-engine 每店循环重复拉取
let ozonInventoryCache: { items: OzonInventoryItem[]; expiresAt: number } | null = null;
const OZON_INVENTORY_CACHE_TTL_MS = 90_000;

/** 从 Ozon API 实时拉取在售商品；任何失败记 warn 并返回空数组（不 500） */
async function fetchOzonInventoryItems(): Promise<OzonInventoryItem[]> {
  if (ozonInventoryCache && Date.now() < ozonInventoryCache.expiresAt) {
    return ozonInventoryCache.items;
  }

  try {
    // 构造 Ozon client（与 webhook-drain.buildOrderClient 同模式，单店取第一个）
    const stores = await getActiveStoreConfigs();
    const store = stores[0];
    if (!store) return [];
    const apiKey = isEncrypted(store.apiKey) ? decrypt(store.apiKey) : store.apiKey;
    const { AuthManager, OzonClient } = await import("@onzo/ozon-api-wrapper");
    const auth = new AuthManager({ clients: [{ clientId: store.clientId, apiKey, storeId: store.storeId }] });
    const client = new OzonClient({ auth });

    // 1. 全量商品 product_id
    const listResp = await client.request<{ result?: { items?: Array<{ product_id: number }> } }>(
      "POST", "/v3/product/list", { filter: { visibility: "ALL" }, limit: 100 },
    );
    const productIds = (listResp.result?.items || []).map((i) => i.product_id).filter(Boolean);
    if (productIds.length === 0) {
      ozonInventoryCache = { items: [], expiresAt: Date.now() + OZON_INVENTORY_CACHE_TTL_MS };
      return [];
    }

    // 2. 商品详情（offer_id / name / 在售状态）
    const infoResp = await client.request<{ items?: Array<{ offer_id?: string; name?: string; statuses?: { status_name?: string } }> }>(
      "POST", "/v3/product/info/list", { product_id: productIds },
    );
    // 排除停售品（statuses.status_name="Не продается"，如 67F 商标停售）——
    // 停售品不应参与调价决策（2026-08-15 实证 67F 被反复评分触发无效调价）
    const infos = (infoResp.items || []).filter((i) => i.statuses?.status_name !== "Не продается");

    // 3. 售价（RUB 字符串 → number）
    const priceResp = await client.request<{ items?: Array<{ offer_id?: string; price?: { price?: string } }> }>(
      "POST", "/v5/product/info/prices", { filter: { product_id: productIds.map(String) }, limit: 100 },
    );
    const { getExchangeRate } = await import("../services/exchange-rate.js");
    const cnyToRub = (await getExchangeRate().catch(() => null))?.rate ?? 11.5;
    const priceByOffer = new Map<string, number>();
    for (const p of priceResp.items || []) {
      const offerId = String(p.offer_id || "");
      // v5 prices 返回店铺合同币种 CNY；契约 price 为 RUB —— 换算（decision-engine 以 cost(CNY)×rate 对齐）
      const cny = parseFloat(String(p.price?.price || "0")) || 0;
      if (offerId) priceByOffer.set(offerId, Math.round(cny * cnyToRub * 100) / 100);
    }

    // 4. 库存（stocks[].present 汇总）
    const stockResp = await client.request<{ items?: Array<{ offer_id?: string; stocks?: Array<{ present?: number }> }> }>(
      "POST", "/v4/product/info/stocks", { filter: { product_id: productIds.map(String), visibility: "ALL" }, limit: 100 },
    );
    const stockByOffer = new Map<string, number>();
    for (const s of stockResp.items || []) {
      const offerId = String(s.offer_id || "");
      if (offerId) stockByOffer.set(offerId, (s.stocks || []).reduce((sum, st) => sum + (Number(st.present) || 0), 0));
    }

    // 5. 1688 采购成本（CNY）+ 重量（kg），按 ozon_offer_id 匹配；查不到记 0
    const costByOffer = new Map<string, number>();
    const weightByOffer = new Map<string, number>();
    const db = await getDb().catch(() => null);
    if (db) {
      const costRows = await db.all<{ ozon_offer_id: string; purchase_price_cny: number; weight_kg: number }>(
        `SELECT ozon_offer_id, MAX(purchase_price_cny) AS purchase_price_cny, MAX(weight_kg) AS weight_kg
         FROM sku_1688_mapping GROUP BY ozon_offer_id`,
      ).catch(() => [] as Array<{ ozon_offer_id: string; purchase_price_cny: number; weight_kg: number }>);
      for (const row of costRows) {
        costByOffer.set(String(row.ozon_offer_id), Number(row.purchase_price_cny) || 0);
        weightByOffer.set(String(row.ozon_offer_id), Number(row.weight_kg) || 0);
      }
    }

    // 6. 合成 promo-agent 契约字段；只保留有价格且库存>0 的在售商品
    const items: OzonInventoryItem[] = [];
    for (const info of infos) {
      const offerId = String(info.offer_id || "").trim();
      if (!offerId) continue;
      const price = priceByOffer.get(offerId) || 0;
      const stock = stockByOffer.get(offerId) || 0;
      if (price <= 0 || stock <= 0) continue;
      items.push({
        offerId,
        name: String(info.name || offerId),
        price,
        stock,
        cost: costByOffer.get(offerId) || 0,
        weight: weightByOffer.get(offerId) || 0,
        rating: 0,
        orders: 0,
        revenue: 0,
        quantity: stock,
      });
    }

    ozonInventoryCache = { items, expiresAt: Date.now() + OZON_INVENTORY_CACHE_TTL_MS };
    logger.info({ count: items.length }, "Ozon inventory fallback loaded");
    return items;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Ozon inventory fallback failed — returning empty items");
    return [];
  }
}

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

      // 本地表为空 → 回退到 Ozon 实时在售商品
      if (items.length === 0) {
        const fallbackItems = await fetchOzonInventoryItems();
        res.json({ items: fallbackItems.slice(0, limit) });
        return;
      }
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
        // 本地无记录 → 回退到 Ozon 实时商品中查找
        const fallbackItem = (await fetchOzonInventoryItems()).find((i) => i.offerId === offerId);
        if (!fallbackItem) {
          res.status(404).json({ error: "Product not found", offerId });
          return;
        }
        res.json({ ...fallbackItem, reviewCount: 0 });
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

      // ★ 先推 Ozon 真实改价（/v1/product/import/prices，店铺合同币种 CNY）。
      // 只落本地表会"假成功"：product_performance 为空 → 0 行更新，Ozon 价不变，
      // 决策引擎每轮从实时 fallback 读到同一旧价 → 重复同一调价永不收敛（2026-08-18 实证）。
      const stores = await getActiveStoreConfigs();
      const store = stores[0];
      if (!store) { res.status(503).json({ error: "No active store config" }); return; }
      const apiKey = isEncrypted(store.apiKey) ? decrypt(store.apiKey) : store.apiKey;
      const { AuthManager, OzonClient } = await import("@onzo/ozon-api-wrapper");
      const auth = new AuthManager({ clients: [{ clientId: store.clientId, apiKey, storeId: store.storeId }] });
      const client = new OzonClient({ auth });
      const { getExchangeRate } = await import("../services/exchange-rate.js");
      const cnyToRub = (await getExchangeRate().catch(() => null))?.rate ?? 11.5;
      const priceCny = (Math.round((price / cnyToRub) * 100) / 100).toFixed(2);
      const pushResp = await client.request<{
        result?: Array<{ offer_id?: string; updated?: boolean; errors?: Array<{ description?: string }> }>;
      }>("POST", "/v1/product/import/prices", {
        prices: [{ offer_id: offerId, price: priceCny, currency_code: "CNY" }],
      });
      const pushItem = (pushResp.result || [])[0];
      // Ozon errors 元素结构不固定（description/code/message 都可能缺）— 全字段保留，否则只剩 "unknown" 无法定位
      const pushErrors = (pushItem?.errors || []).map((e) => {
        const rec = e as Record<string, unknown>;
        return [e.description, rec.code, rec.message].filter(Boolean).join("/") || JSON.stringify(e);
      });
      if (!pushItem || pushItem.updated === false || pushErrors.length > 0) {
        logger.error({ offerId, price, priceCny, pushItem }, "Ozon price push failed");
        res.status(502).json({
          error: `Ozon price push failed: ${pushErrors.join("; ") || "not updated"}`,
          offerId,
          ozonResponse: pushItem ?? null,
        });
        return;
      }

      // Ozon 推送成功后才落本地表 + 审计

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

      // ★ 价格×重量双维自动迁仓（CEL 官方档位表，8/20 用户供图）：
      // XS(…150) ≤500g且≤135¥ ｜ Budget(…290, DISABLED) 501g-30kg且≤135¥ ｜ Small(…520) ≤2kg且135-635¥
      // Big(…710) 2-30kg且135-635¥ ｜ Premium Small(…150 CLE陆运5) 1-5kg且635-22525¥ ｜ Premium Big(…120) ≥5kg且635-22525¥
      // 幂等：目标仓=rfbs 总库存、其余仓=0。失败不阻断（价格已改成功，可手动 temp/move-stocks-xs.cjs 兜底）。
      try {
        const WH = {
          XS: 1020005021424150,      // CEL陆运 Extra Small
          BUDGET: 1020005021424290,  // CEL陆运2 Budget（DISABLED，落档需先在后台启用）
          SMALL: 1020005021424520,   // CEL陆运3 Standard Small
          BIG: 1020005021424710,     // CEL仓库3 Economy Big
          PREM_S: 1020005027799150,  // CLE陆运5 Standard Premium Small（打窝船仓，8/20 用户建仓）
          PREM_B: 1020005027716120,  // CEL陆运4 Standard Premium Big
        };
        const cny = parseFloat(priceCny);
        const stockResp = await client.request<{
          items?: Array<{ product_id?: number; stocks?: Array<{ type?: string; present?: number }> }>;
        }>("POST", "/v4/product/info/stocks", { filter: { offer_id: [offerId], visibility: "ALL" }, limit: 10 });
        const stockItem = (stockResp.items || [])[0];
        const productId = stockItem?.product_id;
        const totalStock = (stockItem?.stocks || [])
          .filter((s) => s.type === "rfbs")
          .reduce((sum, s) => sum + (Number(s.present) || 0), 0);

        // 重量（克）与价格共同决定档位
        let weightG = 0;
        try {
          const attrResp = await client.request<{
            result?: Array<{ weight?: number }>;
          }>("POST", "/v4/product/info/attributes", { filter: { offer_id: [offerId], visibility: "ALL" }, limit: 1 });
          weightG = Number((attrResp.result || [])[0]?.weight) || 0;
        } catch { /* 查不到按 0 处理 */ }

        if (productId && totalStock > 0 && !isNaN(cny)) {
          let target: number;
          if (cny <= 135) target = weightG <= 500 ? WH.XS : WH.BUDGET;
          else if (cny <= 635) target = weightG <= 2000 ? WH.SMALL : WH.BIG;
          else target = weightG <= 5000 ? WH.PREM_S : WH.PREM_B;
          const stocks = Object.values(WH).map((wid) => ({
            offer_id: offerId, product_id: productId,
            stock: wid === target ? totalStock : 0, warehouse_id: wid,
          }));
          await client.request("POST", "/v2/products/stocks", { stocks });
          logger.info({ offerId, priceCny: cny, totalStock, weightG, targetWarehouse: target }, "Warehouse auto-migrated by price band");
        }
      } catch (whErr) {
        logger.warn({ offerId, err: (whErr as Error).message }, "Warehouse auto-migration failed (price already updated)");
      }

      logger.info({ offerId, oldPrice, newPrice: price, priceCny }, "Price updated (Ozon pushed)");
      res.json({ success: true, offerId, oldPrice, newPrice: price, priceCny });
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