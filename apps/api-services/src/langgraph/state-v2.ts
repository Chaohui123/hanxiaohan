// ============================================================
// LangGraph Full Pipeline State v2 — Product Launch to Profit
// Orchestrates: ops-agent ↔ promo-agent
// ============================================================

import { Annotation } from "@langchain/langgraph";

/** Product input from user */
export interface ProductInput {
  sourceUrl: string;
  storeId: string;
  titleRu?: string;
  priceRub?: number;
  weightKg?: number;
}

/** Listing result from Ozon */
export interface ListingResult {
  productId: number;
  offerId: string;
  status: string;
}

/** Ad campaign from promo-agent */
export interface PromoResult {
  planId: string;
  status: string;
  actions: Array<{ offerId: string; type: string; suggestedPrice?: number }>;
  dailyBudget?: number;
}

/** Order summary for profit calculation */
export interface OrderSummary {
  totalOrders: number;
  totalRevenueRub: number;
  totalCommissionRub: number;
  totalPayoutRub: number;
}

/** Full pipeline profit result */
export interface FullProfitResult {
  costCny: number;
  revenueRub: number;
  adSpendRub: number;
  netProfitRub: number;
  marginPercent: number;
  isProfitable: boolean;
}

/** Agent node status */
export interface AgentNodeStatus {
  agent: "ops" | "promo";
  node: string;
  success: boolean;
  error?: string;
  durationMs: number;
}

export const ProductLaunchState = Annotation.Root({
  // Input
  sourceUrl: Annotation<string>(),
  storeId: Annotation<string>(),
  taskId: Annotation<string>(),

  // Ops: Analysis
  analysisResult: Annotation<string>(),
  analysisError: Annotation<string>(),

  // Ops: Listing
  listing: Annotation<ListingResult | null>(),
  listingError: Annotation<string>(),

  // Promo: Ad
  promo: Annotation<PromoResult | null>(),
  promoError: Annotation<string>(),

  // Ops: Orders
  orders: Annotation<OrderSummary | null>(),
  ordersError: Annotation<string>(),

  // Final profit
  fullProfit: Annotation<FullProfitResult | null>(),
  profitError: Annotation<string>(),

  // Agent status log
  agentLog: Annotation<AgentNodeStatus[]>(),

  // Alerts
  alerts: Annotation<Array<{ level: string; event: string; message: string }>>(),
});
