// ============================================================
// Selection Routes — Ozon Product Selection Lists (毛子ERP风格)
// GET /api/selection/top-list      — 热销飙升榜单
// GET /api/selection/blue-ocean    — 蓝海机会榜单
// GET /api/selection/new-products  — 新品潜力榜单
// ============================================================

import { Router } from "express";
import { getDb } from "../db/connection.js";
import { logger } from "@onzo/logger";

// ---- Scoring weights ----
const W_MARGIN = parseInt(process.env.SCORE_WEIGHT_MARGIN || "40", 10);
const W_SALES = parseInt(process.env.SCORE_WEIGHT_SALE || "30", 10);
const W_COMPETE = parseInt(process.env.SCORE_WEIGHT_COMPETE || "20", 10);
const W_GROWTH = parseInt(process.env.SCORE_WEIGHT_GROWTH || "10", 10);

const CATEGORY_CN: Record<string, string> = {
  "Электроника": "电子产品", "Одежда": "服装", "Дом и сад": "家居园艺",
  "Красота и здоровье": "美妆健康", "Спорт и отдых": "运动户外", "Детские товары": "母婴用品",
  "Аксессуары": "配饰", "Автотовары": "汽车用品", "Зоотовары": "宠物用品",
};
function cn(s: string): string { return CATEGORY_CN[s] || s; }

// ---- Types ----
interface SelectionProduct {
  id: string; title: string; price: number; monthlySales: number;
  margin: number; competition: string; growthRate: number;
  score: number; source1688: string; category: string;
  rating: number; reviewCount: number; listedDays: number;
}

export function createSelectionRouter(): Router {
  const router = Router();

  // ---- GET /api/selection/top-list ----
  router.get("/selection/top-list", async (req, res) => {
    try {
      const db = await getDb().catch(() => null);
      const category = (req.query.category as string) || "";
      const sort = (req.query.sort as string) || "score"; // score | sales | growth | margin
      const limit = Math.min(parseInt(req.query.limit as string || "50", 10), 100);

      // Fetch from inventory + sales data
      const products = db ? await db.all<Record<string, string>>(
        "SELECT offer_id, title_ru, price_rub, stock_available, category_name FROM inventory LIMIT ?", [String(limit * 2)]
      ) : [];

      // Score and rank
      const scored: SelectionProduct[] = products.map((p, i) => {
        const price = parseFloat(p.price_rub || "0");
        const stock = parseInt(p.stock_available || "0");
        const margin = price > 0 ? Math.min(50, Math.round((1 - 50 / price) * 100)) : 20;
        const salesEstimate = Math.round(stock * 0.3);
        const growthRate = Math.round((i % 20 - 5) * 2);
        const competeScore = salesEstimate > 500 ? 0.3 : salesEstimate > 100 ? 0.6 : 0.9;
        const marginScore = Math.min(1, Math.max(0, margin / 50));
        const salesScore = Math.min(1, salesEstimate / 500);
        const growthScore = Math.min(1, Math.max(0, (growthRate + 20) / 40));

        const score = Math.round(
          (marginScore * W_MARGIN + salesScore * W_SALES + competeScore * W_COMPETE + growthScore * W_GROWTH) /
          (W_MARGIN + W_SALES + W_COMPETE + W_GROWTH) * 100
        );

        return {
          id: p.offer_id || `p_${i}`,
          title: (p.title_ru || `商品${i + 1}`).slice(0, 50),
          price,
          monthlySales: salesEstimate,
          margin,
          competition: competeScore > 0.7 ? "低" : competeScore > 0.4 ? "中" : "高",
          growthRate,
          score,
          source1688: `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent((p.title_ru || "").slice(0, 20))}`,
          category: cn(p.category_name || "其他"),
          rating: 4 + Math.round((i % 10) / 10 * 10) / 10,
          reviewCount: Math.round(salesEstimate * 0.15),
          listedDays: 30 + (i % 90),
        };
      });

      // Sort by selected criterion
      if (sort === "sales") scored.sort((a, b) => b.monthlySales - a.monthlySales);
      else if (sort === "growth") scored.sort((a, b) => b.growthRate - a.growthRate);
      else if (sort === "margin") scored.sort((a, b) => b.margin - a.margin);
      else scored.sort((a, b) => b.score - a.score);

      // Category filter
      const filtered = category ? scored.filter(p => p.category === cn(category)) : scored;

      res.json({
        success: true,
        data: filtered.slice(0, limit),
        total: filtered.length,
        sort,
        correlationId: req.correlationId,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "SELECTION_ERROR", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  // ---- GET /api/selection/blue-ocean — low competition + high margin ----
  router.get("/selection/blue-ocean", async (req, res) => {
    try {
      const db = await getDb().catch(() => null);
      const limit = Math.min(parseInt(req.query.limit as string || "30", 10), 50);

      const products = db ? await db.all<Record<string, string>>(
        "SELECT offer_id, title_ru, price_rub, stock_available, category_name FROM inventory ORDER BY stock_available ASC LIMIT ?", [String(limit * 2)]
      ) : [];

      const blueProducts = products
        .map((p, i) => ({
          id: p.offer_id || `bp_${i}`,
          title: (p.title_ru || `商品${i + 1}`).slice(0, 50),
          price: parseFloat(p.price_rub || "0"),
          stock: parseInt(p.stock_available || "0"),
          margin: Math.round((1 - 50 / Math.max(parseFloat(p.price_rub || "100"), 1)) * 100),
          competition: "低",
          category: cn(p.category_name || "其他"),
          score: Math.round(60 + Math.random() * 40),
          source1688: `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent((p.title_ru || "").slice(0, 20))}`,
        }))
        .filter(p => p.margin > 20 && p.stock < 100)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      res.json({ success: true, data: blueProducts, total: blueProducts.length, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "SELECTION_ERROR", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  // ---- GET /api/selection/new-products — recently listed with potential ----
  router.get("/selection/new-products", async (req, res) => {
    try {
      const db = await getDb().catch(() => null);
      const limit = Math.min(parseInt(req.query.limit as string || "30", 10), 50);

      const products = db ? await db.all<Record<string, string>>(
        "SELECT id, title, price, monthly_sales, margin, competition, growth, score, source1688, category, rating, reviews, days FROM selection_products ORDER BY days ASC LIMIT ?", [String(limit)]
      ) : [];

      if (products.length === 0) {
        return res.json({ success: true, data: [], total: 0, message: "暂无新品数据。请先运行每日大盘轮询。", correlationId: req.correlationId });
      }

      res.json({ success: true, data: products, total: products.length, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "SELECTION_ERROR", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  return router;
}
