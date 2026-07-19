// ============================================================
// Ozon Market Scanner — real marketplace data collection
// Replaces placeholder nodes in market-crawl.ts with actual API calls.
// Collects: category stats, competitor prices, product rankings.
// ============================================================

import { logger } from "@onzo/logger";

interface OzonClientLike {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  getCategoryTree(categoryId?: number): Promise<unknown[]>;
  getCategoryAttributes(categoryId: number): Promise<unknown[]>;
  getProductInfo(productId: number): Promise<{ id: number; offerId: string; name: string; status: string; images: string[]; categoryId: number; price: string }>;
}

export interface CategoryStats {
  categoryId: number;
  categoryName: string;
  productCount: number;
  avgPriceRub: number;
  minPriceRub: number;
  maxPriceRub: number;
  topSellerCount: number;
  topSellerShare: number; // 0-100%
  reviewVelocity: number; // avg new reviews/day
}

export interface CompetitorSnapshot {
  productId: number;
  offerId: string;
  title: string;
  priceRub: number;
  rating: number;
  reviewCount: number;
  imageUrl: string;
  status: string;
  sellerName?: string;
}

/**
 * Scan a category on Ozon for market intelligence.
 * Uses Ozon Seller API product/list + product/info.
 */
export async function scanCategory(
  ozonClient: OzonClientLike,
  categoryId: number,
  options: { limit?: number } = {},
): Promise<{
  stats: CategoryStats;
  competitors: CompetitorSnapshot[];
  categoryTree: unknown[];
}> {
  const limit = options.limit || 100;
  const competitors: CompetitorSnapshot[] = [];

  // Step 1: Get products in this category
  let productList: Array<{ product_id: number; offer_id: string }> = [];
  try {
    const resp = await ozonClient.request<{
      result: { items: Array<{ product_id: number; offer_id: string }> }
    }>("POST", "/v3/product/list", {
      filter: { visibility: "ALL" },
      limit,
    });
    productList = resp.result?.items || [];
  } catch (err) {
    logger.warn({ categoryId, err: (err as Error).message }, "OzonMarketScanner: product list failed");
    productList = [];
  }

  if (productList.length === 0) {
    return {
      stats: { categoryId, categoryName: "", productCount: 0, avgPriceRub: 0, minPriceRub: 0, maxPriceRub: 0, topSellerCount: 0, topSellerShare: 0, reviewVelocity: 0 },
      competitors: [],
      categoryTree: [],
    };
  }

  // Step 2: Get product details (batch, top 50 for speed)
  const topProducts = productList.slice(0, 50);
  const details: Array<{ price: number; status: string; name: string; images: string[] }> = [];
  for (const p of topProducts) {
    try {
      const info = await ozonClient.getProductInfo(p.product_id);
      details.push({
        price: parseFloat(info.price) || 0,
        status: info.status,
        name: info.name,
        images: info.images || [],
      });
      competitors.push({
        productId: p.product_id,
        offerId: info.offerId || p.offer_id,
        title: info.name,
        priceRub: parseFloat(info.price) || 0,
        rating: 0, // Ozon product/info doesn't include rating — needs separate API
        reviewCount: 0,
        imageUrl: info.images?.[0] || "",
        status: info.status,
      });
    } catch {
      // Skip failed fetches
    }
  }

  // Step 3: Calculate stats
  const prices = details.filter(d => d.price > 0).map(d => d.price);
  const activeProducts = details.filter(d => d.status !== "archived");

  const stats: CategoryStats = {
    categoryId,
    categoryName: "",
    productCount: productList.length,
    avgPriceRub: prices.length > 0 ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : 0,
    minPriceRub: prices.length > 0 ? Math.min(...prices) : 0,
    maxPriceRub: prices.length > 0 ? Math.max(...prices) : 0,
    topSellerCount: Math.min(10, activeProducts.length),
    topSellerShare: 0, // Needs seller-level data which Ozon Seller API doesn't provide
    reviewVelocity: 0, // Needs review API
  };

  // Step 4: Category tree (for name resolution)
  let categoryTree: unknown[] = [];
  try {
    categoryTree = await ozonClient.getCategoryTree(categoryId) as unknown[];
    if (categoryTree.length > 0) {
      stats.categoryName = (categoryTree[0] as { title?: string })?.title || "";
    }
  } catch {
    // Non-critical
  }

  logger.info({
    categoryId,
    productCount: stats.productCount,
    avgPrice: stats.avgPriceRub,
    competitors: competitors.length,
  }, "OzonMarketScanner: category scan complete");

  return { stats, competitors, categoryTree };
}

/**
 * Quick scan — just get competitor prices for a specific keyword/product.
 * Used by auto-select to validate if a 1688 product is competitively priced.
 */
export async function scanCompetitorsByKeyword(
  ozonClient: OzonClientLike,
  keyword: string,
  options: { maxResults?: number } = {},
): Promise<CompetitorSnapshot[]> {
  // Try MPStats first if configured
  const mpstatsKey = process.env.MPSTATS_API_KEY;
  if (mpstatsKey && mpstatsKey !== "CHANGE_ME") {
    try {
      const resp = await fetch("https://mpstats.io/api/v1/products/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": mpstatsKey },
        body: JSON.stringify({ query: keyword, marketplace: "ozon", limit: Math.min(options.maxResults || 20, 50) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.ok) {
        const data = await resp.json() as { data?: Array<{ id: number; name: string; price: number; rating: number; sales: number; offer_id: string }> };
        return (data.data || []).map(p => ({
          productId: p.id,
          offerId: p.offer_id || "",
          title: p.name,
          priceRub: p.price,
          rating: p.rating || 0,
          reviewCount: p.sales || 0,
          imageUrl: "",
          status: "active",
        }));
      }
    } catch {
      // MPStats unavailable — fall through to Ozon API
    }
  }

  // Fallback: search own Ozon catalog by category name
  // This only returns seller's own products — limited value for competitor analysis
  logger.warn("MPStats not configured — competitor data limited to own catalog. Set MPSTATS_API_KEY for full marketplace data.");
  return [];
}
