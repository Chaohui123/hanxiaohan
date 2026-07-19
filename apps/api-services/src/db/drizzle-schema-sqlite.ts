// ============================================================
// Drizzle ORM Schema — SQLite fallback (subset of drizzle-schema.ts)
// ============================================================
//
// IMPORTANT: This is a SUBSET of the PostgreSQL schema in drizzle-schema.ts.
// It only contains tables needed in standalone/SQLite mode (no PG available).
//
// When adding a new table:
//  1. Define it in drizzle-schema.ts (PostgreSQL) first — that is the source of truth
//  2. Only mirror to this file if the table is REQUIRED in standalone/SQLite mode
//  3. Keep table names and column names IDENTICAL between the two files
//
// Tables intentionally OMITTED from SQLite (PG-only):
//  - task_queue, failed_tasks, listing_records, price_history
//  - store_configs, stock_alerts, aftersales_cases
//  - market_snapshots, category_opportunities
//  - images, reconciliation_results
//  - rag_aftersales_scripts, rag_competitor_reports
//  - rag_product_knowledge, rag_copy_templates, rag_operations_playbook
// ============================================================

import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const promoWatchList = sqliteTable("promo_watch_list", {
  offerId: text("offer_id").primaryKey(),
  name: text("name").notNull(),
  addedAt: text("added_at"),
});

export const promoCompetitorPrices = sqliteTable("promo_competitor_prices", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  offerId: text("offer_id").notNull(),
  price: real("price").notNull(),
  rating: real("rating").default(0),
  salesCount: integer("sales_count").default(0),
  capturedAt: text("captured_at"),
});

export const promoEvents = sqliteTable("promo_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  payloadJson: text("payload_json"),
  createdAt: text("created_at"),
});

export const promoPricingHistory = sqliteTable("promo_pricing_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  offerId: text("offer_id").notNull(),
  name: text("name"),
  oldPrice: real("old_price"),
  newPrice: real("new_price"),
  reason: text("reason"),
  salesBefore: integer("sales_before").default(0),
  salesAfter7d: integer("sales_after_7d").default(0),
  appliedAt: text("applied_at"),
});

export const promoCopyHistory = sqliteTable("promo_copy_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  offerId: text("offer_id").notNull(),
  name: text("name"),
  titleRu: text("title_ru"),
  salesBefore: integer("sales_before").default(0),
  salesAfter7d: integer("sales_after_7d").default(0),
  appliedAt: text("applied_at"),
});

export const promoDecisions = sqliteTable("promo_decisions", {
  id: text("id").primaryKey(),
  planJson: text("plan_json").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at"),
  executedAt: text("executed_at"),
});

export const promoAuditLog = sqliteTable("promo_audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  actionType: text("action_type").notNull(),
  offerId: text("offer_id"),
  detailsJson: text("details_json"),
  operator: text("operator").default("auto"),
  createdAt: text("created_at"),
});

export const productPerformance = sqliteTable("product_performance", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id"),
  title: text("title"),
  sku: integer("sku").notNull(),
  sales: integer("sales").default(0),
  revenueRub: real("revenue_rub").default(0),
  profitRub: real("profit_rub").default(0),
  margin: real("margin").default(0),
  stock: integer("stock").default(0),
  rating: real("rating").default(0),
  reviewCount: integer("review_count").default(0),
  updatedAt: text("updated_at"),
});

export const dailySales = sqliteTable("daily_sales", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull().unique(),
  orders: integer("orders").default(0),
  revenueRub: real("revenue_rub").default(0),
  profitRub: real("profit_rub").default(0),
  avgOrderValue: real("avg_order_value").default(0),
  updatedAt: text("updated_at"),
});

export const tokenUsage = sqliteTable("token_usage", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  model: text("model").notNull(),
  promptTokens: integer("prompt_tokens").default(0),
  completionTokens: integer("completion_tokens").default(0),
  totalTokens: integer("total_tokens").default(0),
  provider: text("provider").notNull(),
  costEstimate: real("cost_estimate").default(0.0),
  timestamp: text("timestamp"),
});
