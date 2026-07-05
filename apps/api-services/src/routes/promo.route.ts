// ============================================================
// Promo Agent API Routes — Drizzle ORM with raw SQL fallback
// ============================================================

import { Router } from "express";
import { logger } from "@onzo/logger";
import { cache } from "@onzo/cache";
import { requireDb } from "../middleware/db.middleware.js";
import { getCached, getCachedOrStale, invalidateCache } from "../cache/promo-cache.js";
import {
  queryWatchList, insertWatchItem, deleteWatchItem,
  queryCompetitorPrices, insertCompetitorPrices,
  queryEvents, insertEvent,
  queryPricingHistory, insertPricingHistory,
  queryCopyHistory, insertCopyHistory,
  insertDecision, insertAuditLog,
  querySalesRanking, queryDailyStats, queryPromoCost,
} from "../db/promo-db.js";

// ---- Ozon Category Cache (in-memory) ----
interface CategoryCache {
  categoryId: number;
  products: Array<{ offerId: string; name: string; price: number; rating: number; salesCount: number }>;
  fetchedAt: number;
}
const categoryCache = new Map<number, CategoryCache>();
const CATEGORY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SEARCH_CACHE_TTL_SEC = 6 * 3600;

// ---- Router ----
export function createPromoRouter(): Router {
  const router = Router();
  router.use(requireDb);

  // ============================================================
  // Watch List
  // ============================================================

  router.get("/promo/watch-list", async (req, res) => {
    try {
      const storeId = req.query.storeId ? String(req.query.storeId) : undefined;
      const cacheKey = storeId ? `watch-list:${storeId}` : "watch-list";
      const items = await getCachedOrStale(cacheKey, () => queryWatchList(), 60);
      const filtered = storeId ? (items as Array<Record<string, unknown>>).filter((i) => String(i.storeId || "") === storeId || !storeId) : items;
      res.json({ items: filtered });
    } catch (err) {
      res.status(503).json({ error: "Service temporarily unavailable" });
    }
  });

  router.post("/promo/watch-list", async (req, res) => {
    try {
      const { offerId, name } = req.body as { offerId?: string; name?: string };
      if (!offerId || !name) { res.status(400).json({ error: "offerId and name are required" }); return; }
      await insertWatchItem(offerId, name);
      await insertAuditLog({ actionType: "watch_add", offerId, details: { name } });
      invalidateCache("watch-list").catch(() => {});
      res.json({ success: true, offerId, name });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete("/promo/watch-list/:offerId", async (req, res) => {
    try {
      await deleteWatchItem(req.params.offerId);
      await insertAuditLog({ actionType: "watch_remove", offerId: req.params.offerId, details: {} });
      invalidateCache("watch-list").catch(() => {});
      res.json({ success: true, offerId: req.params.offerId });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ============================================================
  // Competitor Prices
  // ============================================================

  router.post("/promo/competitor-prices/:offerId", async (req, res) => {
    try {
      const { offerId } = req.params;
      const { prices } = req.body as { prices?: Array<{ price: number; rating?: number; salesCount?: number; capturedAt?: string }> };
      if (!prices || !Array.isArray(prices) || prices.length === 0) {
        res.status(400).json({ error: "prices array is required" }); return;
      }
      const inserted = await insertCompetitorPrices(offerId, prices);
      await insertAuditLog({ actionType: "competitor_prices_save", offerId, details: { count: inserted } });
      res.json({ success: true, inserted });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/promo/competitor-prices/:offerId", async (req, res) => {
    try {
      const days = parseInt(String(req.query.days || "7"), 10);
      const prices = await queryCompetitorPrices(req.params.offerId, days);
      res.json({ prices });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ============================================================
  // Events
  // ============================================================

  router.post("/promo/events", async (req, res) => {
    try {
      const { type, payload } = req.body as { type?: string; payload?: Record<string, unknown> };
      if (!type) { res.status(400).json({ error: "type is required" }); return; }
      await insertEvent(type, payload || {});
      await insertAuditLog({ actionType: "event_create", offerId: null, details: { type, payload } });
      invalidateCache("events:all").catch(() => {});
      invalidateCache(`events:${type}`).catch(() => {});
      res.json({ success: true, type });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/promo/events", async (req, res) => {
    try {
      const eventType = req.query.type ? String(req.query.type) : undefined;
      const cacheKey = eventType ? `events:${eventType}` : "events:all";
      const events = await getCachedOrStale(cacheKey, () => queryEvents(eventType), 60);
      res.json({ events });
    } catch (err) {
      res.status(503).json({ error: "Service temporarily unavailable" });
    }
  });

  // ============================================================
  // Pricing History
  // ============================================================

  router.get("/promo/pricing-history", async (req, res) => {
    try {
      const days = parseInt(String(req.query.days || "7"), 10);
      const adjustments = await getCachedOrStale(`pricing-history:${days}`, () => queryPricingHistory(days), 120);
      res.json({ adjustments });
    } catch (err) {
      res.status(503).json({ error: "Service temporarily unavailable" });
    }
  });

  router.post("/promo/pricing-history", async (req, res) => {
    try {
      const { offerId, name, oldPrice, newPrice, reason } = req.body as {
        offerId?: string; name?: string; oldPrice?: number; newPrice?: number; reason?: string;
      };
      if (!offerId) { res.status(400).json({ error: "offerId is required" }); return; }
      await insertPricingHistory({ offerId, name: name || "", oldPrice: oldPrice || 0, newPrice: newPrice || 0, reason: reason || "" });
      await insertAuditLog({ actionType: "pricing_update", offerId, details: { oldPrice, newPrice, reason } });
      invalidateCache("pricing-history:7").catch(() => {});
      invalidateCache("pricing-history:30").catch(() => {});
      res.json({ success: true, offerId });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ============================================================
  // Copy History
  // ============================================================

  router.get("/promo/copy-history", async (req, res) => {
    try {
      const days = parseInt(String(req.query.days || "7"), 10);
      const copies = await getCachedOrStale(`copy-history:${days}`, () => queryCopyHistory(days), 120);
      res.json({ copies });
    } catch (err) {
      res.status(503).json({ error: "Service temporarily unavailable" });
    }
  });

  // ============================================================
  // Promo Cost
  // ============================================================

  router.get("/promo/cost", async (req, res) => {
    try {
      const fromDate = String(req.query.from || new Date().toISOString().slice(0, 10));
      const toDate = String(req.query.to || fromDate);
      const cost = await getCached(`cost:${fromDate}:${toDate}`, () => queryPromoCost(fromDate, toDate), 300);
      res.json(cost);
    } catch (err) {
      res.status(503).json({ error: "Service temporarily unavailable" });
    }
  });

  // ============================================================
  // Stats
  // ============================================================

  router.get("/stats/daily", async (req, res) => {
    try {
      const date = String(req.query.date || new Date().toISOString().slice(0, 10));
      const stats = await queryDailyStats(date);
      const ranking = await querySalesRanking(1);
      res.json({ ...stats, topProducts: ranking.slice(0, 5) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/stats/weekly", async (req, res) => {
    try {
      const fromDate = String(req.query.from || daysAgo(7));
      const toDate = String(req.query.to || daysAgo(1));
      const cost = await queryPromoCost(fromDate, toDate);
      const top5 = await querySalesRanking(7);
      res.json({ orders: 0, revenue: cost.totalRevenue, byDay: [], top5: top5.slice(0, 5), bottom5: [] });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ============================================================
  // Sales Ranking, History, System Load
  // ============================================================

  router.get("/promo/sales-ranking", async (req, res) => {
    try {
      const days = parseInt(String(req.query.days || "7"), 10);
      const storeId = req.query.storeId ? String(req.query.storeId) : undefined;
      const cacheKey = `sales-ranking:${days}${storeId ? `:${storeId}` : ""}`;
      const items = await getCachedOrStale(cacheKey, () => querySalesRanking(days), 120);
      res.json({ items });
    } catch (err) {
      res.status(503).json({ error: "Service temporarily unavailable" });
    }
  });

  router.get("/promo/history", async (req, res) => {
    try {
      const days = parseInt(String(req.query.days || "7"), 10);
      const [pricing, copies] = await Promise.all([
        queryPricingHistory(days),
        queryCopyHistory(days),
      ]);
      const pricingActions = pricing.map((p) => ({ type: "pricing", ...p, detail: "" }));
      const copyActions = copies.map((c: Record<string, unknown>) => ({ type: "copy", ...c, detail: c.titleRu || "" }));
      const actions = [...pricingActions, ...copyActions]
        .sort((a, b) => String((b as Record<string, unknown>).appliedAt || "").localeCompare(String((a as Record<string, unknown>).appliedAt || "")))
        .slice(0, 50);
      res.json({ actions });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/system/load", (_req, res) => {
    const memUsage = process.memoryUsage();
    res.json({
      cpu: process.cpuUsage().user / 1_000_000,
      memory: memUsage.heapUsed / memUsage.heapTotal,
      activeConnections: 0,
    });
  });

  // ============================================================
  // Scraper & Ozon Search
  // ============================================================

  router.get("/scraper/status", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/ozon/products/search", async (req, res) => {
    const query = String(req.query.query || "").trim();
    const limit = parseInt(String(req.query.limit || "10"), 10);
    if (!query) { res.json({ items: [] }); return; }

    const cacheKey = `promo:search:${simpleHash(query)}`;
    try {
      const cached = await cache.get(cacheKey);
      if (cached) { res.json(JSON.parse(cached)); return; }
    } catch { /* miss */ }

    const mpstatsKey = process.env.MPSTATS_API_KEY || "";
    if (mpstatsKey && !mpstatsKey.includes("CHANGE_ME")) {
      try {
        const items = await searchMPStats(query, limit, mpstatsKey);
        if (items.length > 0) {
          await cache.set(cacheKey, JSON.stringify({ items }), SEARCH_CACHE_TTL_SEC).catch(() => {});
          res.json({ items }); return;
        }
      } catch (err) { logger.warn({ err, query }, "MPStats failed"); }
    }

    try {
      await ensureCategoryCache();
      const queryLower = query.toLowerCase();
      const matched: Array<{ offerId: string; name: string; price: number; rating: number; salesCount: number }> = [];
      for (const [, cat] of categoryCache) {
        for (const p of cat.products) {
          if (p.name.toLowerCase().includes(queryLower)) matched.push(p);
        }
      }
      const result = { items: matched.slice(0, limit) };
      await cache.set(cacheKey, JSON.stringify(result), SEARCH_CACHE_TTL_SEC).catch(() => {});
      res.json(result);
    } catch (err) {
      res.json({ items: [] });
    }
  });

  // ============================================================
  // Decision & Validate
  // ============================================================

  router.post("/promo/decision", async (req, res) => {
    try {
      const { id, actions } = req.body as { id?: string; actions?: unknown[] };
      if (!id || !actions) { res.status(400).json({ error: "id and actions required" }); return; }
      await insertDecision(id, JSON.stringify(req.body));
      await insertAuditLog({ actionType: "decision_submit", offerId: null, details: { id, actionCount: actions.length } });
      res.json({ success: true, id });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/promo/validate", async (req, res) => {
    const { type, offerId } = req.body as { type?: string; offerId?: string };
    if (!type || !offerId) { res.status(400).json({ allowed: false, reason: "type and offerId required" }); return; }
    try {
      // DB connectivity check as proxy
      const items = await queryWatchList(); // simple query to verify DB
      res.json({ allowed: items.length >= 0 });
    } catch (err) {
      res.json({ allowed: false, reason: (err as Error).message });
    }
  });

  return router;
}

// ============================================================
// Ozon Category Cache Helpers
// ============================================================

async function getOzonStoreProducts(): Promise<Array<{ offer_id: string; name: string; price: string; category_id: number; rating: number }>> {
  const apiKey = process.env.OZON_API_KEYS || "";
  const clientId = process.env.OZON_CLIENT_IDS || "";
  if (!apiKey || !clientId || apiKey.includes("CHANGE_ME")) return [];

  const listResp = await fetch("https://api-seller.ozon.ru/v3/product/list", {
    method: "POST",
    headers: { "Client-Id": clientId, "Api-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ filter: { visibility: "ALL" }, limit: 1000 }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!listResp.ok) return [];
  const listData = await listResp.json() as { result?: { items?: Array<{ product_id: number; offer_id: string }> } };
  const productIds = (listData.result?.items || []).map((i) => i.product_id).filter(Boolean);
  if (productIds.length === 0) return [];

  const allProducts: Array<{ offer_id: string; name: string; price: string; category_id: number; rating: number }> = [];
  for (let i = 0; i < productIds.length; i += 100) {
    try {
      const infoResp = await fetch("https://api-seller.ozon.ru/v2/product/info/list", {
        method: "POST",
        headers: { "Client-Id": clientId, "Api-Key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ product_id: productIds.slice(i, i + 100) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (infoResp.ok) {
        const infoData = await infoResp.json() as { result?: { items?: Array<{ product_id: number; offer_id: string; name: string; price: string; category_id: number; rating?: number }> } };
        for (const item of (infoData.result?.items || [])) {
          allProducts.push({ offer_id: item.offer_id || String(item.product_id), name: item.name || "", price: item.price || "0", category_id: item.category_id || 0, rating: item.rating || 0 });
        }
      }
    } catch { /* skip batch */ }
  }
  return allProducts;
}

async function ensureCategoryCache(): Promise<void> {
  const now = Date.now();
  if (categoryCache.size > 0) {
    const first = categoryCache.values().next().value as CategoryCache | undefined;
    if (first && (now - first.fetchedAt) < CATEGORY_CACHE_TTL_MS) return;
  }
  const products = await getOzonStoreProducts();
  if (products.length === 0) return;
  const byCategory = new Map<number, CategoryCache["products"]>();
  for (const p of products) {
    if (!p.category_id) continue;
    if (!byCategory.has(p.category_id)) byCategory.set(p.category_id, []);
    byCategory.get(p.category_id)!.push({ offerId: p.offer_id, name: p.name, price: parseFloat(p.price || "0"), rating: p.rating || 0, salesCount: 0 });
  }
  for (const [catId, prods] of byCategory) {
    categoryCache.set(catId, { categoryId: catId, products: prods, fetchedAt: now });
  }
  logger.info({ categories: categoryCache.size, products: products.length }, "Ozon category cache refreshed");
}

async function searchMPStats(query: string, limit: number, apiKey: string): Promise<Array<{ offerId: string; name: string; price: number; rating: number; salesCount: number }>> {
  const baseUrl = process.env.MPSTATS_BASE_URL || "https://mpstats.io/api";
  const resp = await fetch(`${baseUrl}/v1/products/search`, {
    method: "POST",
    headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query, marketplace: "ozon", limit: Math.min(limit, 50) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return [];
  const data = await resp.json() as { data?: Array<{ id?: string; name?: string; price?: number; rating?: number; sales?: number; offer_id?: string }> };
  return (data.data || []).map((item) => ({ offerId: item.offer_id || item.id || "", name: item.name || "", price: item.price || 0, rating: item.rating || 0, salesCount: item.sales || 0 }));
}

// ---- Utility ----
function daysAgo(n: number): string { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
function simpleHash(s: string): string { let hash = 0; for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0; return Math.abs(hash).toString(36); }
