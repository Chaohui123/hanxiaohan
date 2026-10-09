// ============================================================
// 竞品威胁分过滤（2026-10 调价引擎改造）
// 背景：原 competitorAvg 简单均价会被"价格带外/零销量/低评分"竞品拉偏，
// 现按 价格相关性(0-50) + 销量威胁(0-30) + 评分威胁(0-20) 打威胁分，
// <40 分不纳入均价；剩余竞品按威胁分加权，使高威胁竞品主导定价锚点。
// ============================================================

export interface CompetitorQuote {
  price: number;
  rating: number;
  salesCount: number;
}

/** 威胁分纳入阈值：低于该分不进入 competitorAvg */
export const THREAT_MIN_SCORE = 40;

/** 价格带边界：相对我方价偏离超过该比例即视为带外（价格分 0） */
const PRICE_BAND = 0.3;

/** 价格相关性 0-50：|price-ourPrice|/ourPrice ≤ 0.3 → 50×(1-偏离/0.3)；> 0.3 → 0 */
export function priceRelevanceScore(competitorPrice: number, ourPrice: number): number {
  if (!(competitorPrice > 0) || !(ourPrice > 0)) return 0;
  const deviation = Math.abs(competitorPrice - ourPrice) / ourPrice;
  if (deviation > PRICE_BAND) return 0;
  return 50 * (1 - deviation / PRICE_BAND);
}

/** 销量威胁 0-30：≥100→30；10-99→20；1-9→10；0→0 */
export function salesThreatScore(salesCount: number): number {
  if (salesCount >= 100) return 30;
  if (salesCount >= 10) return 20;
  if (salesCount >= 1) return 10;
  return 0;
}

/** 评分威胁 0-20：≥4.5→20；4.0-4.49→12；<4.0→5 */
export function ratingThreatScore(rating: number): number {
  if (rating >= 4.5) return 20;
  if (rating >= 4.0) return 12;
  return 5;
}

/** 综合威胁分（0-100） */
export function competitorThreatScore(competitor: CompetitorQuote, ourPrice: number): number {
  return (
    priceRelevanceScore(competitor.price, ourPrice) +
    salesThreatScore(competitor.salesCount) +
    ratingThreatScore(competitor.rating)
  );
}

/**
 * 威胁分过滤 + 加权均价：
 * - 威胁分 < THREAT_MIN_SCORE 的竞品不纳入
 * - 剩余 ≥1 个时按威胁分加权平均
 * - 全被滤掉（或空列表）→ 0（调用方走成本定价分支）
 */
export function threatWeightedAverage(competitors: CompetitorQuote[], ourPrice: number): number {
  let weightSum = 0;
  let weightedPriceSum = 0;
  for (const c of competitors) {
    const score = competitorThreatScore(c, ourPrice);
    if (score < THREAT_MIN_SCORE) continue;
    weightSum += score;
    weightedPriceSum += c.price * score;
  }
  if (weightSum === 0) return 0;
  return weightedPriceSum / weightSum;
}
