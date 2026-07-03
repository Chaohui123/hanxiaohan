// ============================================================
// Product Scorer — competitiveness analysis without ML
// Uses simple heuristics: price position, trend, sales signals
// ============================================================

export interface ProductScore {
  productSku: string;
  totalScore: number;        // 0-100
  priceScore: number;        // 0-40 — competitive pricing
  trendScore: number;        // 0-30 — price stability/growth
  volumeScore: number;       // 0-30 — sales velocity signals
  recommendation: "strong_buy" | "consider" | "watch" | "skip";
  summary: string;
}

/**
 * Score a product's competitiveness based on available data.
 * No ML — pure heuristics suitable for Phase 2.
 */
export function scoreProduct(params: {
  ourPriceRub: number;
  competitorPrices: Array<{ priceRub: number; platform: string }>;
  salesSignals?: { totalSold?: number; reviewCount?: number; rating?: number };
  priceHistory?: Array<{ avgPrice: number; date: string }>;
}): ProductScore {
  // Price score (0-40): how competitive is our price vs competitors?
  let priceScore = 0;
  if (params.competitorPrices.length > 0) {
    const avgCompetitor = params.competitorPrices.reduce((s, p) => s + p.priceRub, 0) / params.competitorPrices.length;
    const minCompetitor = Math.min(...params.competitorPrices.map((p) => p.priceRub));
    // Lower than average → good
    if (params.ourPriceRub <= minCompetitor) priceScore = 40;
    else if (params.ourPriceRub <= avgCompetitor * 0.9) priceScore = 35;
    else if (params.ourPriceRub <= avgCompetitor) priceScore = 25;
    else if (params.ourPriceRub <= avgCompetitor * 1.1) priceScore = 15;
    else priceScore = 5;
  } else {
    priceScore = 20; // unknown — neutral
  }

  // Trend score (0-30): is price stable or improving?
  let trendScore = 15; // neutral
  if (params.priceHistory && params.priceHistory.length >= 3) {
    const recent = params.priceHistory.slice(0, 3);
    const first = recent[recent.length - 1].avgPrice;
    const last = recent[0].avgPrice;
    if (last < first * 0.95) trendScore = 10; // price dropping — bad
    else if (last > first * 1.05) trendScore = 25; // price rising — good
    else trendScore = 20; // stable
  }

  // Volume score (0-30): sales velocity signals
  let volumeScore = 0;
  if (params.salesSignals) {
    if (params.salesSignals.totalSold && params.salesSignals.totalSold > 1000) volumeScore += 15;
    else if (params.salesSignals.totalSold && params.salesSignals.totalSold > 100) volumeScore += 8;

    if (params.salesSignals.reviewCount && params.salesSignals.reviewCount > 50) volumeScore += 10;
    else if (params.salesSignals.reviewCount && params.salesSignals.reviewCount > 10) volumeScore += 5;

    if (params.salesSignals.rating && params.salesSignals.rating >= 4.5) volumeScore += 5;
  }

  const totalScore = Math.min(100, priceScore + trendScore + volumeScore);

  const recommendation: ProductScore["recommendation"] =
    totalScore >= 70 ? "strong_buy" :
    totalScore >= 50 ? "consider" :
    totalScore >= 30 ? "watch" : "skip";

  const summary = recommendation === "strong_buy"
    ? "Highly competitive — price below market average with strong sales signals"
    : recommendation === "consider"
    ? "Good potential — monitor competitor moves"
    : recommendation === "watch"
    ? "Wait for better entry point or price adjustment"
    : "Not recommended — price too high or weak demand signals";

  return {
    productSku: params.ourPriceRub.toString(),
    totalScore,
    priceScore,
    trendScore,
    volumeScore,
    recommendation,
    summary,
  };
}
