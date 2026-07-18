// ============================================================
// Market Analysis State — 7 modules for Ozon market intelligence
// ============================================================

import { Annotation } from "@langchain/langgraph";

/** Market overview data */
export interface MarketOverview {
  categoryName: string;
  totalSales: number;
  visitorScale: string;
  seasonality: string;
  commissionRate: number;
  entryBarrier: string;
  platformEvents: string[];
  rawJson: string;
}

/** Category deep-dive */
export interface CategoryAnalysis {
  categoryName: string;
  top100Sales: number;
  topSellerCount: number;
  monopolyRatio: number;
  returnRate: number;
  complaintRate: number;
  rawJson: string;
}

/** Single product analysis */
export interface ProductAnalysis {
  productId: string;
  title: string;
  monthlySales: number;
  reviewCount: number;
  rating: number;
  variants: string[];
  trafficSource: string;
  promotionFrequency: string;
  stockVolatility: string;
  rawJson: string;
}

/** Keyword research */
export interface KeywordAnalysis {
  suggestions: string[];
  adKeywords: Array<{ word: string; bidPrice: number; competition: string }>;
  searchVolume: Record<string, number>;
  naturalRanking: Array<{ url: string; position: number }>;
  rawJson: string;
}

/** Cost breakdown */
export interface CostBreakdown {
  purchaseCostCny: number;
  logisticsCostRub: number;
  platformFeeRub: number;
  withdrawalFeeRub: number;
  vatRub: number;
  packagingRub: number;
  adCostRub: number;
  returnLossRub: number;
  totalCostRub: number;
  unitNetProfitRub: number;
  marginPercent: number;
  breakEvenVolume: number;
  rawJson: string;
}

/** Competitor pricing */
export interface CompetitorAnalysis {
  competitors: Array<{
    title: string; priceRub: number; rating: number; salesCount: number;
    hasBundle: boolean; shippingTemplate: string; giftStrategy: string;
  }>;
  avgPriceRub: number;
  priceRange: { min: number; max: number };
  rawJson: string;
}

/** Pricing recommendation */
export interface PricingRecommendation {
  breakEvenPrice: number;
  optimalPrice: number;
  tieredPromo: Array<{ volume: number; price: number }>;
  profitByVolume: Array<{ volume: number; profit: number }>;
}

/** LLM unified analysis report */
export interface MarketReport {
  summary: string;
  marketOverviewLLM: string;
  categoryAnalysisLLM: string;
  productAnalysisLLM: string;
  keywordAnalysisLLM: string;
  pricingRecommendationLLM: string;
  costBreakdownLLM: string;
  competitorAnalysisLLM: string;
  overallScore: number;
  recommendation: string;
  generatedAt: string;
}

// ---- State ----

export const MarketAnalysisState = Annotation.Root({
  // Input
  category: Annotation<string>(),
  productId: Annotation<string>(),
  keyword: Annotation<string>(),
  taskId: Annotation<string>(),

  // Ops crawl results
  marketOverview: Annotation<MarketOverview | null>(),
  categoryAnalysis: Annotation<CategoryAnalysis | null>(),
  productAnalysis: Annotation<ProductAnalysis | null>(),
  costBreakdown: Annotation<CostBreakdown | null>(),
  competitorAnalysis: Annotation<CompetitorAnalysis | null>(),
  opsCrawlErrors: Annotation<string[]>(),

  // Promo crawl results
  keywordAnalysis: Annotation<KeywordAnalysis | null>(),
  promoCrawlErrors: Annotation<string[]>(),

  // Pricing recommendation
  pricing: Annotation<PricingRecommendation | null>(),
  pricingError: Annotation<string>(),

  // LLM report
  llmReport: Annotation<MarketReport | null>(),
  llmError: Annotation<string>(),

  // Excel export
  reportId: Annotation<string>(),
  exportError: Annotation<string>(),

  // Alerts
  alerts: Annotation<Array<{ level: string; event: string; message: string }>>(),
  hasFailures: Annotation<boolean>(),
});
