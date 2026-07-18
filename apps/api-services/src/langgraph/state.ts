// ============================================================
// LangGraph Workflow State — Ozon Procurement Pipeline v1
// Uses @langchain/langgraph Annotation.Root() pattern
// ============================================================

import { Annotation } from "@langchain/langgraph";

/** Single product within an Ozon order */
export interface OrderProduct {
  sku: number;
  name: string;
  quantity: number;
  price: number;
}

/** Ozon order */
export interface OzonOrder {
  postingNumber: string;
  orderId: number;
  status: string;
  products: OrderProduct[];
  totalPriceRub: number;
  createdAt: string;
}

/** 1688 source match for a product SKU */
export interface SourceMatch {
  sku: number;
  offerId: string | null;
  source1688Url: string;
  purchasePriceCny: number;
  weightKg: number;
  freightAddress: string;
  supplierName: string;
}

/** Profit calculation result */
export interface ProfitResult {
  totalCostCny: number;
  totalRevenueRub: number;
  exchangeRate: number;
  netProfitRub: number;
  marginPercent: number;
  isProfitable: boolean;
}

/** RAG query result */
export interface RagResult {
  query: string;
  answer: string;
  sources: string[];
  tokensUsed: number;
}

/** Alert payload */
export interface AlertPayload {
  level: "info" | "warn" | "error" | "critical";
  event: string;
  message: string;
  postingNumber: string;
  detail: Record<string, string>;
}

// ---- LangGraph State (v1 Annotation.Root) ----

export const ProcurementState = Annotation.Root({
  storeId: Annotation<string>(),
  postingNumber: Annotation<string>(),
  ragQuery: Annotation<string>(),

  // Order sync
  ozonOrder: Annotation<OzonOrder | null>(),
  orderSyncError: Annotation<string>(),

  // Source matching
  sourceMatches: Annotation<SourceMatch[]>(),
  matchError: Annotation<string>(),

  // Profit
  profit: Annotation<ProfitResult | null>(),
  profitError: Annotation<string>(),

  // RAG
  ragResult: Annotation<RagResult | null>(),
  ragError: Annotation<string>(),

  // Purchase
  purchaseId: Annotation<string>(),
  purchaseError: Annotation<string>(),

  // Alerts
  alerts: Annotation<AlertPayload[]>(),
});
