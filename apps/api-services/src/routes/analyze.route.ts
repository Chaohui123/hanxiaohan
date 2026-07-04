import { Router } from "express";
import { ProductAnalyzer, type ProductAnalysis, type AnalysisOptions } from "../services/product-analyzer.js";
import { PricingEngine } from "../services/pricing-engine.js";
import { analyzeBlueOcean, clearBlueOceanCache } from "../services/blue-ocean-analyzer.js";
import { analyzeReturnRisk, getPriorityCategories, calculateReturnCost } from "../services/return-risk-analyzer.js";
import { analyzeProductForRussia, getHighDemandCategoriesForCurrentSeason, getAutoPartCategoriesSorted } from "../services/russia-market-rules.js";
import type { OzonClient } from "@onzo/ozon-api-wrapper";

export function createAnalyzeRouter(ozonClient?: OzonClient): Router {
  const router = Router();
  const analyzer = new ProductAnalyzer();
  const pricingEngine = new PricingEngine();

  // GET /analyze/blue-ocean — dynamic blue ocean analysis (24h cache)
  router.get("/analyze/blue-ocean", async (req, res) => {
    try {
      const results = await analyzeBlueOcean(ozonClient);
      res.json({ success: true, data: results, count: results.length, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "ANALYSIS_FAILED", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  // POST /analyze/blue-ocean/refresh — force refresh
  router.post("/analyze/blue-ocean/refresh", (_req, res) => {
    clearBlueOceanCache();
    res.json({ success: true, message: "Cache cleared — next request will re-analyze", correlationId: _req.correlationId });
  });

  // POST /analyze — product analysis
  router.post("/analyze", async (req, res) => {
    try {
      const { products, competitors, options } = req.body as {
        products: Array<{ sourceUrl: string; title: string; categoryPath: string[]; price: { currentMin: number; currentMax: number }; specifications?: Record<string, string> }>;
        competitors?: Array<{ sourceUrl: string; productId: number; priceRub: number; rating: number; reviewCount: number; salesVolume: number; title: string }>;
        options?: AnalysisOptions;
      };

      if (!products?.length) {
        res.status(400).json({ success: false, error: { code: "MISSING_PRODUCTS", message: "products array required" }, correlationId: req.correlationId });
        return;
      }

      const results: ProductAnalysis[] = [];
      for (const product of products) {
        const scraped = { ...product, scrapeTimestamp: new Date().toISOString(), specImages: [], detailImages: [], specifications: [], descriptionText: product.title, salesInfo: {}, price: { ...product.price, currency: "CNY" as const } };
        const analysis = await analyzer.analyzeProduct(scraped as unknown as Parameters<typeof analyzer.analyzeProduct>[0], competitors || [], options);
        results.push(analysis);
      }

      res.json({ success: true, data: results, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "ANALYSIS_FAILED", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  // GET /analyze/russia-market — Russian market analysis
  router.get("/analyze/russia-market", (req, res) => {
    try {
      const query = (req.query.query as string) || "";
      const analysis = analyzeProductForRussia({ title: query, categoryPath: [], price: { currentMin: 0, currentMax: 0, currency: "CNY" }, sourceUrl: "", descriptionText: "", specifications: [], specImages: [], detailImages: [] });
      const highDemand = getHighDemandCategoriesForCurrentSeason();
      const autoParts = getAutoPartCategoriesSorted();
      res.json({ success: true, data: { analysis, highDemand, autoParts }, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "MARKET_ANALYSIS_FAILED", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  // POST /analyze/return-risk — return risk analysis
  router.post("/analyze/return-risk", (req, res) => {
    try {
      const { category, productType, hasSizeVariants, hasColorVariants, isElectronic } = req.body as {
        category?: string; productType?: string; hasSizeVariants?: boolean; hasColorVariants?: boolean; isElectronic?: boolean;
      };
      const risk = analyzeReturnRisk({ category, productType, hasSizeVariants, hasColorVariants, isElectronic });
      const priority = getPriorityCategories();
      res.json({ success: true, data: { risk, priorityCategories: priority }, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "RISK_ANALYSIS_FAILED", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  // POST /analyze/return-cost — return cost calculation
  router.post("/analyze/return-cost", (req, res) => {
    try {
      const { productPriceRub, weightKg, category } = req.body as { productPriceRub: number; weightKg?: number; category?: string };
      const cost = calculateReturnCost(productPriceRub, weightKg, category);
      res.json({ success: true, data: cost, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "COST_CALC_FAILED", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  return router;
}
