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
  /** 成本折算 RUB（cost(CNY)×实时汇率），评分阶段算好供调价使用 */
  costRub: number;
  currentPrice: number;
  stock: number;
  marginPercent: number;
  competitorAvg: number;
  priceAdvantage: number;
  salesGrowth7d: number;
  rating: number;
  totalScore: number;
  /** 调价底价（RUB）：毛利≥20% 与 净利≥10% 双底线取大，低于此价不调 */
  floorPrice: number;
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
/** 价格劣势触发调价的阈值：我方价高于精准竞品均价 5% 即"不利可调整" */
const PRICING_DISADVANTAGE_PCT = parseFloat(process.env.PROMO_PRICING_DISADV_PCT || "-5");
/** 明显低于竞品（价格优势>15%）且利润充足时可适度涨价 */
const PRICING_RAISE_ADVANTAGE_PCT = parseFloat(process.env.PROMO_PRICING_RAISE_PCT || "15");

export function getRecommendation(
  totalScore: number, marginPct: number, priceAdvantagePct: number,
): { recommendation: ProductScore["recommendation"]; reason: string } {
  if (totalScore < SCORE_THRESHOLD) {
    return { recommendation: "skip", reason: `综合评分过低 (${totalScore}/100)` };
  }
  // 价格不利（高于竞品均价）：降价（核心场景，2026-08-14 方案定稿）
  if (priceAdvantagePct < PRICING_DISADVANTAGE_PCT && marginPct >= 20) {
    return { recommendation: "pricing", reason: `价格高于竞品均价 ${Math.abs(priceAdvantagePct).toFixed(0)}%，不利可降价（净利≥10% 底价保护）` };
  }
  // 明显低于竞品且利润充足：适度涨价拿回利润
  if (priceAdvantagePct > PRICING_RAISE_ADVANTAGE_PCT && marginPct >= 20) {
    return { recommendation: "pricing", reason: `价格低于竞品均价 ${priceAdvantagePct.toFixed(0)}%，可适度涨价` };
  }
  // 利润率不足：提价修复
  if (marginPct < 20) {
    return { recommendation: "pricing", reason: `利润率 ${marginPct.toFixed(0)}% 低于 20% 底线，需提价修复` };
  }
  const needCopy = marginPct >= 20 && priceAdvantagePct < 10;
  if (needCopy) return { recommendation: "copy", reason: `利润率 ${marginPct.toFixed(0)}% 良好，优化文案提升转化` };
  return { recommendation: "skip", reason: "各项指标正常，无需操作" };
}
