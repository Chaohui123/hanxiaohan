// ============================================================
// Promo Agent API Routes — main router mounting sub-routers
// ============================================================

import { Router } from "express";
import { logger } from "@onzo/logger";
import { cache } from "@onzo/cache";
import { requireDb } from "../middleware/db.middleware.js";
import { createWatchRouter } from "./promo-watch.router.js";
import { createPromoDataRouter } from "./promo-data.router.js";
import { insertDecision, insertAuditLog, queryWatchList } from "../db/promo-db.js";

// ---- Ozon Search Helpers ----
interface CategoryCache {
  categoryId: number;
  products: Array<{ offerId: string; name: string; price: number; rating: number; salesCount: number }>;
  fetchedAt: number;
}
const categoryCache = new Map<number, CategoryCache>();
const CATEGORY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SEARCH_CACHE_TTL_SEC = 6 * 3600;

export function createPromoRouter(): Router {
  const router = Router();
  router.use(requireDb);

  // Mount sub-routers
  router.use(createWatchRouter());
  router.use(createPromoDataRouter());

  // ---- System Load ----
  router.get("/system/load", (_req, res) => {
    const memUsage = process.memoryUsage();
    res.json({ cpu: process.cpuUsage().user / 1_000_000, memory: memUsage.heapUsed / memUsage.heapTotal, activeConnections: 0 });
  });

  // ---- Scraper Status ----
  router.get("/scraper/status", (_req, res) => { res.json({ status: "ok" }); });

  // ---- Ozon Product Search ----
  router.get("/ozon/products/search", async (req, res) => {
    const query = String(req.query.query || "").trim();
    const limit = parseInt(String(req.query.limit || "10"), 10);
    if (!query) { res.json({ items: [] }); return; }

    const cacheKey = `promo:search:${simpleHash(query)}`;
    try { const cached = await cache.get(cacheKey); if (cached) { res.json(JSON.parse(cached)); return; } } catch { /* miss */ }

    const mpstatsKey = process.env.MPSTATS_API_KEY || "";
    if (mpstatsKey && !mpstatsKey.includes("CHANGE_ME")) {
      try {
        const items = await searchMPStats(query, limit, mpstatsKey);
        if (items.length > 0) { await cache.set(cacheKey, JSON.stringify({ items }), SEARCH_CACHE_TTL_SEC).catch(() => {}); res.json({ items }); return; }
      } catch (err) { logger.warn({ err, query }, "MPStats failed"); }
    }

    try {
      await ensureCategoryCache();
      const ql = query.toLowerCase();
      const matched: Array<{ offerId: string; name: string; price: number; rating: number; salesCount: number }> = [];
      for (const [, cat] of categoryCache) for (const p of cat.products) if (p.name.toLowerCase().includes(ql)) matched.push(p);
      await cache.set(cacheKey, JSON.stringify({ items: matched.slice(0, limit) }), SEARCH_CACHE_TTL_SEC).catch(() => {});
      res.json({ items: matched.slice(0, limit) });
    } catch { res.json({ items: [] }); }
  });

  // ---- Decision Submission ----
  router.post("/promo/decision", async (req, res) => {
    try {
      const { id, actions } = req.body as { id?: string; actions?: unknown[] };
      if (!id || !actions) { res.status(400).json({ error: "id and actions required" }); return; }
      await insertDecision(id, JSON.stringify(req.body));
      await insertAuditLog({ actionType: "decision_submit", offerId: null, details: { id, actionCount: actions.length } });
      res.json({ success: true, id });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  // ---- Action Validation ----
  router.post("/promo/validate", async (req, res) => {
    const { type, offerId } = req.body as { type?: string; offerId?: string };
    if (!type || !offerId) { res.status(400).json({ allowed: false, reason: "type and offerId required" }); return; }
    try { const items = await queryWatchList(); res.json({ allowed: items.length >= 0 }); }
    catch (err) { res.json({ allowed: false, reason: (err as Error).message }); }
  });

  return router;
}

// ---- Ozon Helpers ----
async function getOzonStoreProducts(): Promise<Array<{ offer_id: string; name: string; price: string; category_id: number; rating: number }>> {
  const apiKey = process.env.OZON_API_KEYS || "", clientId = process.env.OZON_CLIENT_IDS || "";
  if (!apiKey || !clientId || apiKey.includes("CHANGE_ME")) return [];
  const listResp = await fetch("https://api-seller.ozon.ru/v3/product/list", { method: "POST", headers: { "Client-Id": clientId, "Api-Key": apiKey, "Content-Type": "application/json" }, body: JSON.stringify({ filter: { visibility: "ALL" }, limit: 1000 }), signal: AbortSignal.timeout(15_000) });
  if (!listResp.ok) return [];
  const listData = await listResp.json() as { result?: { items?: Array<{ product_id: number }> } };
  const ids = (listData.result?.items || []).map((i) => i.product_id).filter(Boolean);
  if (!ids.length) return [];
  const all: Array<{ offer_id: string; name: string; price: string; category_id: number; rating: number }> = [];
  for (let i = 0; i < ids.length; i += 100) {
    try {
      const r = await fetch("https://api-seller.ozon.ru/v2/product/info/list", { method: "POST", headers: { "Client-Id": clientId, "Api-Key": apiKey, "Content-Type": "application/json" }, body: JSON.stringify({ product_id: ids.slice(i, i + 100) }), signal: AbortSignal.timeout(15_000) });
      if (r.ok) { const d = await r.json() as { result?: { items?: Array<{ product_id: number; offer_id: string; name: string; price: string; category_id: number; rating?: number }> } }; for (const item of d.result?.items || []) all.push({ offer_id: item.offer_id || String(item.product_id), name: item.name || "", price: item.price || "0", category_id: item.category_id || 0, rating: item.rating || 0 }); }
    } catch { /* skip */ }
  }
  return all;
}

async function ensureCategoryCache(): Promise<void> {
  const now = Date.now();
  if (categoryCache.size > 0) { const f = categoryCache.values().next().value as CategoryCache | undefined; if (f && (now - f.fetchedAt) < CATEGORY_CACHE_TTL_MS) return; }
  const prods = await getOzonStoreProducts(); if (!prods.length) return;
  const byCat = new Map<number, CategoryCache["products"]>();
  for (const p of prods) { if (!p.category_id) continue; if (!byCat.has(p.category_id)) byCat.set(p.category_id, []); byCat.get(p.category_id)!.push({ offerId: p.offer_id, name: p.name, price: parseFloat(p.price || "0"), rating: p.rating || 0, salesCount: 0 }); }
  for (const [cid, plist] of byCat) categoryCache.set(cid, { categoryId: cid, products: plist, fetchedAt: now });
  logger.info({ categories: categoryCache.size, products: prods.length }, "Ozon category cache refreshed");
}

async function searchMPStats(query: string, limit: number, apiKey: string): Promise<Array<{ offerId: string; name: string; price: number; rating: number; salesCount: number }>> {
  const r = await fetch(`${process.env.MPSTATS_BASE_URL || "https://mpstats.io/api"}/v1/products/search`, { method: "POST", headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" }, body: JSON.stringify({ query, marketplace: "ozon", limit: Math.min(limit, 50) }), signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return [];
  const d = await r.json() as { data?: Array<{ id?: string; name?: string; price?: number; rating?: number; sales?: number; offer_id?: string }> };
  return (d.data || []).map((i) => ({ offerId: i.offer_id || i.id || "", name: i.name || "", price: i.price || 0, rating: i.rating || 0, salesCount: i.sales || 0 }));
}

function simpleHash(s: string): string { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return Math.abs(h).toString(36); }
