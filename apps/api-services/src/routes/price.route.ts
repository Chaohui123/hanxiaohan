// ============================================================
// Price routes — competitor monitoring + product scoring
// ============================================================

import { Router } from "express";
import { validateBody } from "../middleware/validate.js";
import { getDb } from "../db/connection.js";

export function createPriceRouter(): Router {
  const router = Router();

  // POST /api/price/scan — ingest competitor prices
  router.post("/price/scan",
    validateBody([{ field: "prices", type: "array", required: true, min: 1 }]),
    async (req, res) => {
    const { prices } = req.body as {
      prices: Array<{
        platform: "ozon" | "wildberries";
        productSku: string; productTitle: string;
        priceRub: number; oldPriceRub?: number;
        url: string;
      }>;
    };

    if (!prices || !Array.isArray(prices) || prices.length === 0) {
      res.status(400).json({ success: false, error: { code: "MISSING_PRICES", message: "prices array required", retryable: false }, correlationId: req.correlationId });
      return;
    }

    try {
      const { PriceScanner } = await import("@onzo/price-monitor");
      const db = await getDb();
      if (!db) {
        res.status(503).json({ success: false, error: { code: "DB_UNAVAILABLE", message: "Database not available", retryable: true }, correlationId: req.correlationId });
        return;
      }

      const scanner = new PriceScanner(db);
      const now = new Date().toISOString();
      const result = await scanner.ingestPrices(prices.map((p) => ({ ...p, capturedAt: now })));

      res.json({ success: true, data: result, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "SCAN_FAILED", message: (err as Error).message, retryable: true }, correlationId: req.correlationId });
    }
  });

  // GET /api/price/trends/:sku — price trend over N days
  router.get("/price/trends/:sku", async (req, res) => {
    try {
      const { PriceScanner } = await import("@onzo/price-monitor");
      const db = await getDb();
      if (!db) { res.json({ success: true, data: [] }); return; }

      const scanner = new PriceScanner(db);
      const days = parseInt(req.query.days as string || "30", 10);
      const trends = await scanner.getPriceTrend(req.params.sku, days);

      res.json({ success: true, data: trends, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "TRENDS_FAILED", message: (err as Error).message, retryable: true }, correlationId: req.correlationId });
    }
  });

  // POST /api/price/score — score a product for competitiveness
  router.post("/price/score",
    validateBody([
      { field: "ourPriceRub", type: "number", required: true },
      { field: "competitorPrices", type: "array", required: true, min: 1 },
    ]),
    async (req, res) => {
    const { ourPriceRub, competitorPrices, salesSignals, productSku } = req.body as {
      ourPriceRub: number;
      competitorPrices: Array<{ priceRub: number; platform: string }>;
      salesSignals?: { totalSold?: number; reviewCount?: number; rating?: number };
      productSku?: string;
    };

    if (!ourPriceRub || !competitorPrices) {
      res.status(400).json({ success: false, error: { code: "MISSING_FIELDS", message: "ourPriceRub + competitorPrices required", retryable: false }, correlationId: req.correlationId });
      return;
    }

    try {
      const { scoreProduct } = await import("@onzo/price-monitor");

      // Fetch price history if sku provided
      let priceHistory: Array<{ avgPrice: number; date: string }> = [];
      if (productSku) {
        const db = await getDb();
        if (db) {
          const { PriceScanner } = await import("@onzo/price-monitor");
          const scanner = new PriceScanner(db);
          const trends = await scanner.getPriceTrend(productSku, 7);
          priceHistory = trends.map((t) => ({ avgPrice: t.avgPrice, date: t.date }));
        }
      }

      const score = scoreProduct({ ourPriceRub, competitorPrices, salesSignals, priceHistory });

      res.json({ success: true, data: score, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "SCORE_FAILED", message: (err as Error).message, retryable: true }, correlationId: req.correlationId });
    }
  });

  // POST /api/price/profit — profit breakdown calculator
  router.post("/price/profit",
    validateBody([
      { field: "costCny", type: "number", required: true },
      { field: "sellingPriceRub", type: "number", required: true },
    ]),
    async (req, res) => {
      const { costCny, sellingPriceRub, category, weightKg, exchangeRate } = req.body as {
        costCny: number; sellingPriceRub: number; category?: string; weightKg?: number; exchangeRate?: number;
      };

      const { getExchangeRate } = await import("../services/exchange-rate.js");
      const fx = exchangeRate ?? (await getExchangeRate()).rate;

      const { calculateProfit } = await import("../services/profit-calc.js");
      const result = calculateProfit({ costCny, sellingPriceRub, exchangeRate: fx, category, weightKg });

      res.json({ success: true, data: result, correlationId: req.correlationId });
    }
  );

  return router;
}
