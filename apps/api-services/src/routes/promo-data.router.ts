// ============================================================
// Promo Data Routes — competitor prices, events, history, stats
// ============================================================

import { Router } from "express";
import { getCached, getCachedOrStale, invalidateCache } from "../cache/promo-cache.js";
import {
  queryCompetitorPrices, insertCompetitorPrices,
  queryEvents, insertEvent,
  queryPricingHistory, insertPricingHistory,
  queryCopyHistory,
  querySalesRanking, queryDailyStats, queryPromoCost,
  insertAuditLog,
} from "../db/promo-db.js";

export function createPromoDataRouter(): Router {
  const router = Router();

  // ---- Competitor Prices ----
  router.post("/promo/competitor-prices/:offerId", async (req, res) => {
    try {
      const { offerId } = req.params;
      const { prices } = req.body as { prices?: Array<{ price: number; rating?: number; salesCount?: number; capturedAt?: string }> };
      if (!prices || !Array.isArray(prices) || prices.length === 0) { res.status(400).json({ error: "prices array is required" }); return; }
      const inserted = await insertCompetitorPrices(offerId, prices);
      await insertAuditLog({ actionType: "competitor_prices_save", offerId, details: { count: inserted } });
      res.json({ success: true, inserted });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.get("/promo/competitor-prices/:offerId", async (req, res) => {
    try {
      const days = parseInt(String(req.query.days || "7"), 10);
      const prices = await queryCompetitorPrices(req.params.offerId, days);
      res.json({ prices });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  // ---- Events ----
  router.post("/promo/events", async (req, res) => {
    try {
      const { type, payload } = req.body as { type?: string; payload?: Record<string, unknown> };
      if (!type) { res.status(400).json({ error: "type is required" }); return; }
      await insertEvent(type, payload || {});
      await insertAuditLog({ actionType: "event_create", offerId: null, details: { type, payload } });
      invalidateCache("events:all").catch(() => {});
      invalidateCache(`events:${type}`).catch(() => {});
      res.json({ success: true, type });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.get("/promo/events", async (req, res) => {
    try {
      const eventType = req.query.type ? String(req.query.type) : undefined;
      const cacheKey = eventType ? `events:${eventType}` : "events:all";
      const events = await getCachedOrStale(cacheKey, () => queryEvents(eventType), 60);
      res.json({ events });
    } catch (err) { res.status(503).json({ error: "Service temporarily unavailable" }); }
  });

  // ---- Pricing History ----
  router.get("/promo/pricing-history", async (req, res) => {
    try {
      const days = parseInt(String(req.query.days || "7"), 10);
      const adjustments = await getCachedOrStale(`pricing-history:${days}`, () => queryPricingHistory(days), 120);
      res.json({ adjustments });
    } catch (err) { res.status(503).json({ error: "Service temporarily unavailable" }); }
  });

  router.post("/promo/pricing-history", async (req, res) => {
    try {
      const { offerId, name, oldPrice, newPrice, reason } = req.body as { offerId?: string; name?: string; oldPrice?: number; newPrice?: number; reason?: string };
      if (!offerId) { res.status(400).json({ error: "offerId is required" }); return; }
      await insertPricingHistory({ offerId, name: name || "", oldPrice: oldPrice || 0, newPrice: newPrice || 0, reason: reason || "" });
      await insertAuditLog({ actionType: "pricing_update", offerId, details: { oldPrice, newPrice, reason } });
      invalidateCache("pricing-history:7").catch(() => {});
      invalidateCache("pricing-history:30").catch(() => {});
      res.json({ success: true, offerId });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  // ---- Copy History ----
  router.get("/promo/copy-history", async (req, res) => {
    try {
      const days = parseInt(String(req.query.days || "7"), 10);
      const copies = await getCachedOrStale(`copy-history:${days}`, () => queryCopyHistory(days), 120);
      res.json({ copies });
    } catch (err) { res.status(503).json({ error: "Service temporarily unavailable" }); }
  });

  // ---- Promo Cost ----
  router.get("/promo/cost", async (req, res) => {
    try {
      const fromDate = String(req.query.from || new Date().toISOString().slice(0, 10));
      const toDate = String(req.query.to || fromDate);
      const cost = await getCached(`cost:${fromDate}:${toDate}`, () => queryPromoCost(fromDate, toDate), 300);
      res.json(cost);
    } catch (err) { res.status(503).json({ error: "Service temporarily unavailable" }); }
  });

  // ---- Stats ----
  router.get("/stats/daily", async (req, res) => {
    try {
      const date = String(req.query.date || new Date().toISOString().slice(0, 10));
      const stats = await queryDailyStats(date);
      const ranking = await querySalesRanking(1);
      res.json({ ...stats, topProducts: ranking.slice(0, 5) });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.get("/stats/weekly", async (req, res) => {
    try {
      const fromDate = String(req.query.from || daysAgo(7));
      const toDate = String(req.query.to || daysAgo(1));
      const cost = await queryPromoCost(fromDate, toDate);
      const top5 = await querySalesRanking(7);
      res.json({ orders: 0, revenue: cost.totalRevenue, byDay: [], top5: top5.slice(0, 5), bottom5: [] });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  // ---- Sales Ranking + History ----
  router.get("/promo/sales-ranking", async (req, res) => {
    try {
      const days = parseInt(String(req.query.days || "7"), 10);
      const storeId = req.query.storeId ? String(req.query.storeId) : undefined;
      const cacheKey = `sales-ranking:${days}${storeId ? `:${storeId}` : ""}`;
      const items = await getCachedOrStale(cacheKey, () => querySalesRanking(days), 120);
      res.json({ items });
    } catch (err) { res.status(503).json({ error: "Service temporarily unavailable" }); }
  });

  router.get("/promo/history", async (req, res) => {
    try {
      const days = parseInt(String(req.query.days || "7"), 10);
      const [pricing, copies] = await Promise.all([queryPricingHistory(days), queryCopyHistory(days)]);
      const pricingActions = pricing.map((p) => ({ type: "pricing", ...p, detail: "" }));
      const copyActions = copies.map((c: Record<string, unknown>) => ({ type: "copy", ...c, detail: c.titleRu || "" }));
      const actions = [...pricingActions, ...copyActions]
        .sort((a, b) => String((b as Record<string, unknown>).appliedAt || "").localeCompare(String((a as Record<string, unknown>).appliedAt || "")))
        .slice(0, 50);
      res.json({ actions });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  return router;
}

function daysAgo(n: number): string { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
