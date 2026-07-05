// ============================================================
// Product Scoring Engine — types + pure scoring functions
// ============================================================

// ---- 类型 ----

export interface ProductScore {
  offerId: string;
  name: string;
  storeId?: string;
  storeName?: string;
  cost: number;
  currentPrice: number;
  stock: number;
  marginPercent: number;
  competitorAvg: number;
  priceAdvantage: number;
  salesGrowth7d: number;
  rating: number;
  totalScore: number;
  breakdown: { margin: number; priceAdvantage: number; stock: number; salesGrowth: number; rating: number };
  recommendation: "copy" | "pricing" | "copy_and_pricing" | "skip";
  reason: string;
}

// ---- 评分函数 ----

export function scoreMargin(marginPct: number): number {
  if (marginPct >= 40) return 1.0;
  if (marginPct >= 30) return 0.8;
  if (marginPct >= 20) return 0.6;
  if (marginPct >= 10) return 0.4;
  if (marginPct >= 5) return 0.2;
  return 0;
}

export function scorePriceAdvantage(advantagePct: number): number {
  const capped = Math.min(Math.max(advantagePct, -30), 30);
  return (capped + 30) / 60;
}

export function scoreStock(stock: number): number {
  if (stock >= 50) return 1.0;
  if (stock >= 20) return 0.8;
  if (stock >= 10) return 0.6;
  if (stock >= 5) return 0.4;
  if (stock >= 1) return 0.2;
  return 0;
}

export function scoreSalesGrowth(growthPct: number): number {
  const capped = Math.min(growthPct, 50);
  return capped / 50;
}

export function scoreRating(rating: number): number {
  if (rating >= 4.5) return 1.0;
  if (rating >= 4.0) return 0.8;
  if (rating >= 3.5) return 0.6;
  if (rating >= 3.0) return 0.4;
  if (rating > 0) return 0.2;
  return 0.5;
}

// ---- 推荐策略 ----

const SCORE_THRESHOLD = parseInt(process.env.PROMO_SCORE_THRESHOLD || "40", 10);

export function getRecommendation(
  totalScore: number, marginPct: number, priceAdvantagePct: number,
): { recommendation: ProductScore["recommendation"]; reason: string } {
  if (totalScore < SCORE_THRESHOLD) {
    return { recommendation: "skip", reason: `综合评分过低 (${totalScore}/100)` };
  }
  const needCopy = marginPct >= 15 && priceAdvantagePct < 10;
  const needPricing = marginPct < 15 || priceAdvantagePct > 15;
  if (needCopy && needPricing) return { recommendation: "copy_and_pricing", reason: "利润高但转化低 + 价格需优化" };
  if (needCopy) return { recommendation: "copy", reason: `利润率 ${marginPct.toFixed(0)}% 良好，优化文案提升转化` };
  if (needPricing) return { recommendation: "pricing", reason: `价格竞争力不足 (优势${priceAdvantagePct.toFixed(0)}%)，需调价` };
  return { recommendation: "skip", reason: "各项指标正常，无需操作" };
}
