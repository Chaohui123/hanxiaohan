// ============================================================
// Promo Watch List Routes
// ============================================================

import { Router } from "express";
import { getCachedOrStale, invalidateCache } from "../cache/promo-cache.js";
import { queryWatchList, insertWatchItem, deleteWatchItem, insertAuditLog } from "../db/promo-db.js";

export function createWatchRouter(): Router {
  const router = Router();

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
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.delete("/promo/watch-list/:offerId", async (req, res) => {
    try {
      await deleteWatchItem(req.params.offerId);
      await insertAuditLog({ actionType: "watch_remove", offerId: req.params.offerId, details: {} });
      invalidateCache("watch-list").catch(() => {});
      res.json({ success: true, offerId: req.params.offerId });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  return router;
}
