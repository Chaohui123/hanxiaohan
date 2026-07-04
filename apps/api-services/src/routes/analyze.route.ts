import { Router } from "express";
import { ProductAnalyzer, type ProductAnalysis, type AnalysisOptions } from "../services/product-analyzer.js";
import { PricingEngine, type PricingOptions } from "../services/pricing-engine.js";
import { analyzeForBlueOcean, batchAnalyzeBlueOcean, getOnzoSalesTrends, getTopBlueOceanCategories, getKeywordRecommendations, type BlueOceanAnalysis } from "../services/blue-ocean-analyzer.js";
import { analyzeProductForRussia, getHighDemandCategoriesForCurrentSeason, getAutoPartCategoriesSorted } from "../services/russia-market-rules.js";

export function createAnalyzeRouter(): Router {
  const router = Router();
  const analyzer = new ProductAnalyzer();
  const pricingEngine = new PricingEngine();

  router.post("/analyze", async (req, res) => {
    try {
      const { products, competitors, options } = req.body as {
        products: Array<{
          sourceUrl: string;
          title: string;
          categoryPath: string[];
          price: { currentMin: number; currentMax: number };
          specifications?: Record<string, string>;
        }>;
        competitors?: Array<{
          sourceUrl: string;
          productId: number;
          priceRub: number;
          rating: number;
          reviewCount: number;
          salesVolume: number;
          title: string;
        }>;
        options?: AnalysisOptions;
      };

      const competitorsMap = new Map<string, typeof competitors>();
      if (competitors) {
        for (const comp of competitors) {
          const existing = competitorsMap.get(comp.sourceUrl) || [];
          existing.push(comp);
          competitorsMap.set(comp.sourceUrl, existing);
        }
      }

      const results: ProductAnalysis[] = products.map(product => {
        const productCompetitors = competitorsMap.get(product.sourceUrl) || [];
        return analyzer.analyzeProduct(
          product as unknown as Parameters<typeof analyzer.analyzeProduct>[0],
          productCompetitors,
          options
        );
      });

      res.json({
        success: true,
        data: {
          analyses: results,
          suggestedCount: results.filter(r => r.suggested).length,
          totalCount: results.length
        },
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "ANALYSIS_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.post("/pricing", async (req, res) => {
    try {
      const { costCny, exchangeRate, competitors, options } = req.body as {
        costCny: number;
        exchangeRate?: number;
        competitors: Array<{
          productId: number;
          priceRub: number;
          rating: number;
          reviewCount: number;
          salesVolume: number;
          title: string;
        }>;
        options?: PricingOptions;
      };

      const result = pricingEngine.calculatePrice(
        costCny,
        exchangeRate ?? 12.5,
        competitors,
        options
      );

      res.json({
        success: true,
        data: result,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "PRICING_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.post("/batch-pricing", async (req, res) => {
    try {
      const { products, exchangeRate, options } = req.body as {
        products: Array<{
          costCny: number;
          competitors: Array<{
            productId: number;
            priceRub: number;
            rating: number;
            reviewCount: number;
            salesVolume: number;
            title: string;
          }>;
        }>;
        exchangeRate?: number;
        options?: PricingOptions;
      };

      const results = pricingEngine.calculateBatchPrices(
        products,
        exchangeRate ?? 12.5,
        options
      );

      res.json({
        success: true,
        data: results,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "PRICING_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.get("/competitor-analysis", async (req, res) => {
    try {
      const { productIds } = req.query;
      const ids = typeof productIds === 'string' ? productIds.split(',').map(Number) : [];

      const mockCompetitors = [
        { productId: 1, priceRub: 1299, rating: 4.5, reviewCount: 120, salesVolume: 500 },
        { productId: 2, priceRub: 1499, rating: 4.7, reviewCount: 85, salesVolume: 380 },
        { productId: 3, priceRub: 1199, rating: 4.2, reviewCount: 200, salesVolume: 620 },
      ];

      const filtered = ids.length > 0 
        ? mockCompetitors.filter(c => ids.includes(c.productId))
        : mockCompetitors;

      res.json({
        success: true,
        data: filtered,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "COMPETITOR_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.post("/russia-market", async (req, res) => {
    try {
      const { title, description, categoryPath, weightKg } = req.body as {
        title: string;
        description?: string;
        categoryPath?: string[];
        weightKg?: number;
      };

      const analysis = analyzeProductForRussia(
        title,
        description || '',
        categoryPath || [],
        weightKg || 0.5
      );

      res.json({
        success: true,
        data: analysis,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "MARKET_ANALYSIS_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.post("/blue-ocean", async (req, res) => {
    try {
      const { product, competitors, options } = req.body as {
        product: {
          sourceUrl: string;
          title: string;
          description?: string;
          categoryPath: string[];
          price: { currentMin: number; currentMax: number };
          specifications?: Record<string, string>;
        };
        competitors?: Array<{ priceRub: number; salesVolume?: number }>;
        options?: { exchangeRate?: number; weightKg?: number; costCny?: number; targetMargin?: number };
      };

      const analysis = analyzeForBlueOcean(
        product as unknown as Parameters<typeof analyzeForBlueOcean>[0],
        competitors || [],
        options
      );

      res.json({
        success: true,
        data: analysis,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "BLUE_OCEAN_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.post("/blue-ocean-batch", async (req, res) => {
    try {
      const { products, competitors, options } = req.body as {
        products: Array<{
          sourceUrl: string;
          title: string;
          description?: string;
          categoryPath: string[];
          price: { currentMin: number; currentMax: number };
          specifications?: Record<string, string>;
        }>;
        competitors?: Record<string, Array<{ priceRub: number; salesVolume?: number }>>;
        options?: { exchangeRate?: number; defaultWeightKg?: number; topN?: number };
      };

      const compMap = new Map<string, Array<{ priceRub: number; salesVolume?: number }>>();
      if (competitors) {
        Object.entries(competitors).forEach(([key, value]) => compMap.set(key, value));
      }

      const result = batchAnalyzeBlueOcean(
        products as unknown as Parameters<typeof batchAnalyzeBlueOcean>[0],
        compMap,
        options
      );

      res.json({
        success: true,
        data: result,
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "BATCH_BLUE_OCEAN_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  router.get("/market-trends", async (req, res) => {
    try {
      const trends = getOnzoSalesTrends();
      const highDemandCats = getHighDemandCategoriesForCurrentSeason();
      const autoCats = getAutoPartCategoriesSorted();
      const topBlueOcean = getTopBlueOceanCategories();
      const keywords = getKeywordRecommendations();

      res.json({
        success: true,
        data: {
          salesTrends: trends,
          highDemandCategories: highDemandCats,
          autoPartCategories: autoCats,
          topBlueOcean: topBlueOcean,
          keywordRecommendations: keywords
        },
        correlationId: req.correlationId
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "TRENDS_ERROR", message: (err as Error).message, retryable: true },
        correlationId: req.correlationId
      });
    }
  });

  return router;
}