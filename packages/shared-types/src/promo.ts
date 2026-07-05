export interface ProductScore {
  offerId: string;
  name: string;
  cost: number;
  currentPrice: number;
  stock: number;
  marginPercent: number;
  competitorAvg: number;
  priceAdvantage: number;
  salesGrowth7d: number;
  rating: number;
  totalScore: number;
  breakdown: {
    margin: number;
    priceAdvantage: number;
    stock: number;
    salesGrowth: number;
    rating: number;
  };
  recommendation: "copy" | "pricing" | "copy_and_pricing" | "skip";
  reason: string;
}

export interface DecisionPlan {
  id: string;
  createdAt: string;
  products: ProductScore[];
  actions: PlannedAction[];
  crossValidation: CrossValidationResult;
  status: "pending" | "validated" | "failed" | "executing" | "completed";
  results?: ActionResult[];
  executedAt?: string;
}

export interface PlannedAction {
  offerId: string;
  name: string;
  type: "copy" | "pricing" | "copy_and_pricing";
  suggestedPrice?: number;
  reason: string;
}

export interface CrossValidationResult {
  systemHealthy: boolean;
  apiLatencyOk: boolean;
  noActiveIncidents: boolean;
  budgetRemaining: boolean;
  dailyLimitNotReached: boolean;
  passed: boolean;
  issues: string[];
  validatedAt: string;
}

export interface ActionResult {
  offerId: string;
  name: string;
  type: "copy" | "pricing";
  success: boolean;
  message: string;
  appliedAt: string;
}

export interface CompetitorAlert {
  offerId: string;
  name: string;
  competitorAvg: number;
  myPrice: number;
  dropPercent: number;
  alertLevel: "warning" | "critical";
}

export interface PromoCostSummary {
  adSpend: number;
  totalRevenue: number;
  organicRevenue: number;
  paidRevenue: number;
  roi: number;
}

export interface WatchListItem {
  offerId: string;
  name: string;
  addedAt: string;
}

export interface CompetitorPriceSnapshot {
  price: number;
  rating: number;
  salesCount: number;
  capturedAt: string;
}

export interface PricingHistoryEntry {
  offerId: string;
  name: string;
  oldPrice: number;
  newPrice: number;
  reason: string;
  salesBefore: number;
  salesAfter: number;
  appliedAt: string;
}

export interface CopyHistoryEntry {
  offerId: string;
  name: string;
  titleRu: string;
  salesBefore: number;
  salesAfter: number;
  appliedAt: string;
}
