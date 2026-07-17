// ============================================================
// SKU-1688 Mapping Routes — bind, lookup, profit check, replacement
// ============================================================

import { Router } from "express";
import { getDb } from "../db/connection.js";
import { SkuMappingService } from "../services/sku-mapping.js";
import { logger } from "@onzo/logger";

export function createSkuMappingRouter(): Router {
  const router = Router();

  /** POST /api/sku-mapping/bind — bind Ozon SKU to 1688 source */
  router.post("/sku-mapping/bind", async (req, res) => {
    try {
      const db = await getDb().catch(() => null);
      if (!db) return res.status(503).json({ success: false, error: { code: "DB_UNAVAILABLE", message: "数据库不可用" }, correlationId: req.correlationId });

      const { storeId, ozonOfferId, ozonSku, source1688Url, offer1688Id, sku1688Id, purchasePriceCny, weightKg, freightAddress } = req.body as Record<string, unknown>;
      if (!ozonOfferId || !ozonSku || !source1688Url || purchasePriceCny == null) {
        return res.status(400).json({ success: false, error: { code: "MISSING_FIELDS", message: "ozonOfferId, ozonSku, source1688Url, purchasePriceCny required" }, correlationId: req.correlationId });
      }

      const service = new SkuMappingService(db);
      const mapping = await service.bind({
        storeId: (storeId as string) || "store_1",
        ozonOfferId: ozonOfferId as string,
        ozonSku: ozonSku as number,
        source1688Url: source1688Url as string,
        offer1688Id: offer1688Id as string,
        sku1688Id: sku1688Id as string,
        purchasePriceCny: purchasePriceCny as number,
        weightKg: weightKg as number,
        freightAddress: freightAddress as string,
      });
      res.json({ success: true, data: mapping, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "BIND_ERROR", message: (err as Error).message } });
    }
  });

  /** GET /api/sku-mapping/lookup — lookup mapping by offerId+SKU */
  router.get("/sku-mapping/lookup", async (req, res) => {
    try {
      const storeId = (req.query.storeId as string) || "store_1";
      const offerId = req.query.offerId as string;
      const sku = parseInt(req.query.sku as string || "0", 10);
      if (!offerId || !sku) return res.status(400).json({ success: false, error: { code: "MISSING", message: "offerId and sku required" } });

      const db = await getDb().catch(() => null);
      const service = new SkuMappingService(db);
      const mapping = await service.lookup(storeId, offerId, sku);
      res.json({ success: true, data: mapping, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "LOOKUP_ERROR", message: (err as Error).message } });
    }
  });

  /** GET /api/sku-mapping/list — list all mappings for a store */
  router.get("/sku-mapping/list", async (req, res) => {
    try {
      const storeId = (req.query.storeId as string) || "store_1";
      const limit = Math.min(parseInt(req.query.limit as string || "100", 10), 500);
      const db = await getDb().catch(() => null);
      const service = new SkuMappingService(db);
      const list = await service.listByStore(storeId, limit);
      res.json({ success: true, data: list, count: list.length, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "LIST_ERROR", message: (err as Error).message } });
    }
  });

  /** POST /api/sku-mapping/check-profit — auto-calculate profit */
  router.post("/sku-mapping/check-profit", async (req, res) => {
    try {
      const { storeId, ozonOfferId, ozonSku, ozonSellingPriceRub } = req.body as Record<string, unknown>;
      if (!ozonOfferId || !ozonSku || ozonSellingPriceRub == null) {
        return res.status(400).json({ success: false, error: { code: "MISSING", message: "ozonOfferId, ozonSku, ozonSellingPriceRub required" } });
      }

      const db = await getDb().catch(() => null);
      const service = new SkuMappingService(db);
      const result = await service.checkProfit((storeId as string) || "store_1", ozonOfferId as string, ozonSku as number, ozonSellingPriceRub as number);
      if (!result) {
        return res.json({ success: true, data: { found: false, message: "No mapping found for this SKU" } });
      }
      res.json({ success: true, data: { found: true, ...result } });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "PROFIT_ERROR", message: (err as Error).message } });
    }
  });

  /** POST /api/sku-mapping/replace — RAG-assisted find replacement 1688 source */
  router.post("/sku-mapping/replace", async (req, res) => {
    try {
      const { ozonOfferId, ozonSku } = req.body as Record<string, unknown>;
      if (!ozonOfferId || !ozonSku) return res.status(400).json({ success: false });

      const db = await getDb().catch(() => null);
      const service = new SkuMappingService(db);
      const replacement = await service.findReplacement(ozonOfferId as string, ozonSku as number);
      res.json({ success: true, data: { replacement, found: !!replacement } });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "REPLACE_ERROR", message: (err as Error).message } });
    }
  });

  /** DELETE /api/sku-mapping/:offerId/:sku */
  router.delete("/sku-mapping/:offerId/:sku", async (req, res) => {
    try {
      const storeId = (req.query.storeId as string) || "store_1";
      const db = await getDb().catch(() => null);
      const service = new SkuMappingService(db);
      await service.delete(storeId, req.params.offerId, parseInt(req.params.sku, 10));
      res.json({ success: true, message: "deleted" });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "DELETE_ERROR", message: (err as Error).message } });
    }
  });

  return router;
}