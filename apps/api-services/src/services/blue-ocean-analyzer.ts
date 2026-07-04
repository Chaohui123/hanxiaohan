// ============================================================
// Blue Ocean Analyzer — dynamic multi-source category scoring
// Sources: Ozon tree, local orders, market snapshots, static rules
// ============================================================

import { getDb } from "../db/connection.js";
import { getCategoryTree } from "./category-cache.js";
import { calculateProfit } from "./profit-calc.js";
import { getHighDemandCategoriesForCurrentSeason } from "./russia-market-rules.js";
import type { OzonCategoryNode } from "@onzo/shared-types";
import type { OzonClient } from "@onzo/ozon-api-wrapper";
import { logger } from "@onzo/logger";

export interface BlueOceanAnalysis {
  categoryId: number;
  categoryName: string;
  categoryPath: string[];
  competitionScore: number;    // 0-100, higher = less competition
  profitScore: number;         // 0-100
  growthScore: number;         // 0-100
  demandScore: number;         // 0-100
  overallScore: number;        // 0-100 weighted
  listingCount: number;
  avgPriceRub: number;
  estMargin: number;
  monthOrders: number;
  prevMonthOrders: number;
  recommendation: string;
  dataSource: "dynamic" | "static_fallback";
}

// ---- Cache ----
let analysisCache: { data: BlueOceanAnalysis[]; expiresAt: number; source: string } | null = null;
const CACHE_TTL_MS = 24 * 3600_000; // 24 hours

/**
 * Dynamic blue ocean analysis using Ozon API + local orders + static rules.
 * Falls back to static russia-market-rules data when Ozon API is unavailable.
 */
export async function analyzeBlueOcean(
  ozonClient?: OzonClient,
  exchangeRate?: number
): Promise<BlueOceanAnalysis[]> {
  // Return cache if fresh
  if (analysisCache && analysisCache.expiresAt > Date.now()) {
    return analysisCache.data;
  }

  const results: BlueOceanAnalysis[] = [];
  let dataSource: "dynamic" | "static_fallback" = "dynamic";

  try {
    // 1. Fetch Ozon category tree
    let categoryTree: OzonCategoryNode[] = [];
    if (ozonClient) {
      categoryTree = await getCategoryTree(ozonClient, { ttlHours: 24 }).catch(() => []);
    }

    // 2. Fetch market snapshots from DB (collected by market-data-collector)
    const db = await getDb().catch(() => null);
    const snapshots = db
      ? await db.all("SELECT * FROM market_snapshots ORDER BY captured_at DESC LIMIT 200") as Array<Record<string, unknown>>
      : [];

    const snapshotMap = new Map<number, Record<string, unknown>>();
    for (const s of snapshots) snapshotMap.set(s.category_id as number, s);

    // 3. Fetch local order data (last 60 days vs previous 30)
    const orderData = db
      ? await db.all(
          `SELECT category_id, COUNT(*) as cnt, AVG(total_price_rub) as avgPrice
           FROM local_orders WHERE created_at >= CURRENT_DATE - INTERVAL '60 days' AND status='delivered'
           GROUP BY category_id`
        ) as Array<{ category_id: number; cnt: number; avgPrice: number }>
      : [];

    // 4. Get static market rules as prior knowledge
    const highDemandCategories = getHighDemandCategoriesForCurrentSeason();
    const fx = exchangeRate || 12;

    if (categoryTree.length > 0) {
      // Dynamic analysis from category tree
      await analyzeCategories(categoryTree, [], snapshotMap, orderData, highDemandCategories, fx, results);
    }

    // 5. If dynamic analysis failed or too few results, use static fallback
    if (results.length < 5) {
      dataSource = "static_fallback";
      logger.warn("Blue ocean: insufficient dynamic data, using static fallback");
      const staticResults = generateStaticFallback(fx);
      results.push(...staticResults);
    }

  } catch (err) {
    logger.error({ err: (err as Error).message }, "Blue ocean analysis failed — using static fallback");
    dataSource = "static_fallback";
    results.push(...generateStaticFallback(exchangeRate || 12));
  }

  // Sort by overall score descending
  results.sort((a, b) => b.overallScore - a.overallScore);

  // Cache
  analysisCache = { data: results, expiresAt: Date.now() + CACHE_TTL_MS, source: dataSource };

  // Persist to category_opportunities
  persistResults(results).catch(() => {});

  return results;
}

/** Force refresh the analysis cache */
export function clearBlueOceanCache(): void {
  analysisCache = null;
  logger.info("Blue ocean analysis cache cleared");
}

// ---- Private ----

async function analyzeCategories(
  nodes: OzonCategoryNode[],
  path: string[],
  snapshots: Map<number, Record<string, unknown>>,
  orderData: Array<{ category_id: number; cnt: number; avgPrice: number }>,
  highDemand: ReturnType<typeof getHighDemandCategoriesForCurrentSeason>,
  fx: number,
  results: BlueOceanAnalysis[]
): Promise<void> {
  for (const node of nodes) {
    const currentPath = [...path, node.title];
    const snapshot = snapshots.get(node.categoryId);
    const orders = orderData.filter((o) => o.category_id === node.categoryId);
    const monthOrders = orders.reduce((s, o) => s + o.cnt, 0);

    // Only analyze leaf categories (those with products)
    const listingCount = (snapshot?.listing_count as number) || (snapshot?.product_count as number) || 0;
    if (listingCount > 0 || orders.length > 0) {
      const avgPrice = orders.length > 0
        ? orders.reduce((s, o) => s + o.avgPrice, 0) / orders.length
        : (snapshot?.avg_price_rub as number) || 500;

      // Scores (0-100)
      const competitionScore = Math.min(100, Math.max(0, 100 - Math.log10(listingCount + 1) * 20));
      const profitMargin = calculateProfit({ costCny: avgPrice / fx / 1.3, sellingPriceRub: avgPrice, exchangeRate: fx, weightKg: 0.3 });
      const profitScore = Math.min(100, Math.max(0, profitMargin.marginPercent));
      const growthScore = monthOrders > 0 ? Math.min(100, 50 + (monthOrders - 10) * 2) : 30;
      const demandScore = highDemand.some((d) =>
        currentPath.some((p) => d.category.toLowerCase().includes(p.toLowerCase()) || d.keywords.some((kw) => p.toLowerCase().includes(kw.toLowerCase())))
      ) ? 80 : 40;

      // Weighted overall
      const overallScore = Math.round(
        competitionScore * 0.3 + profitScore * 0.3 + growthScore * 0.2 + demandScore * 0.2
      );

      results.push({
        categoryId: node.categoryId,
        categoryName: node.title,
        categoryPath: currentPath,
        competitionScore: Math.round(competitionScore),
        profitScore: Math.round(profitScore),
        growthScore: Math.round(growthScore),
        demandScore: Math.round(demandScore),
        overallScore,
        listingCount,
        avgPriceRub: Math.round(avgPrice),
        estMargin: profitMargin.marginPercent,
        monthOrders,
        prevMonthOrders: 0,
        recommendation: overallScore >= 70 ? "强烈推荐" : overallScore >= 50 ? "可考虑" : overallScore >= 30 ? "观望" : "跳过",
        dataSource: "dynamic",
      });
    }

    if (node.children?.length > 0) {
      await analyzeCategories(node.children, currentPath, snapshots, orderData, highDemand, fx, results);
    }
  }
}

function generateStaticFallback(fx: number): BlueOceanAnalysis[] {
  const categories = [
    { catId: 17028749, name: "Auto Accessories", path: ["Auto"], count: 2500, price: 800, margin: 45 },
    { catId: 17000001, name: "Home Storage", path: ["Home"], count: 4000, price: 600, margin: 50 },
    { catId: 17000002, name: "Phone Mounts", path: ["Electronics"], count: 1800, price: 500, margin: 50 },
    { catId: 17000003, name: "Tools", path: ["Tools"], count: 2200, price: 1500, margin: 55 },
    { catId: 17000004, name: "Car Cleaning", path: ["Auto"], count: 1500, price: 700, margin: 50 },
    { catId: 17000005, name: "LED Lighting", path: ["Home"], count: 3500, price: 400, margin: 40 },
  ];

  return categories.map((c, i) => ({
    categoryId: c.catId, categoryName: c.name, categoryPath: c.path,
    competitionScore: Math.min(100, 100 - Math.log10(c.count + 1) * 20),
    profitScore: c.margin, growthScore: 40 + i * 10, demandScore: 50 + i * 5,
    overallScore: Math.round((100 - Math.log10(c.count + 1) * 20) * 0.3 + c.margin * 0.3 + (40 + i * 10) * 0.2 + (50 + i * 5) * 0.2),
    listingCount: c.count, avgPriceRub: c.price, estMargin: c.margin,
    monthOrders: 100 - i * 15, prevMonthOrders: 80 - i * 12,
    recommendation: i < 2 ? "强烈推荐" : i < 4 ? "可考虑" : "观望",
    dataSource: "static_fallback" as const,
  }));
}

async function persistResults(results: BlueOceanAnalysis[]): Promise<void> {
  const db = await getDb().catch(() => null);
  if (!db) return;
  for (const r of results.slice(0, 20)) {
    await db.run(
      `INSERT INTO category_opportunities (category_id, category_name, overall_score, listing_count, avg_price_rub, est_margin, month_orders, recommendation, data_source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW()) ON CONFLICT(category_id) DO UPDATE SET overall_score=EXCLUDED.overall_score, listing_count=EXCLUDED.listing_count, avg_price_rub=EXCLUDED.avg_price_rub, month_orders=EXCLUDED.month_orders, recommendation=EXCLUDED.recommendation, data_source=EXCLUDED.data_source, updated_at=NOW()`,
      [r.categoryId, r.categoryName, r.overallScore, r.listingCount, r.avgPriceRub, r.estMargin, r.monthOrders, r.recommendation, r.dataSource]
    ).catch(() => {});
  }
}
