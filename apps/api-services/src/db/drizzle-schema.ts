// ============================================================
// Drizzle ORM Schema Definitions (Phase 1)
// Uses drizzle-orm/sqlite-core for type-safe schema.
// Runtime queries use node:sqlite adapter (no VS C++ tools needed).
// ============================================================

import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

// ---- Task Queue ----
export const taskQueue = sqliteTable("task_queue", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  status: text("status").notNull().default("queued"),
  payloadJson: text("payload_json"),
  correlationId: text("correlation_id"),
  storeId: text("store_id").notNull().default("store_1"),
  createdAt: text("created_at").default("(datetime('now'))"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  errorMessage: text("error_message"),
  retryCount: integer("retry_count").default(0),
  maxRetries: integer("max_retries").default(3),
  priority: integer("priority").default(0),
});

// ---- Failed Tasks ----
export const failedTasks = sqliteTable("failed_tasks", {
  id: text("id").primaryKey(),
  storeId: text("store_id").notNull(),
  taskType: text("task_type").notNull(),
  payloadJson: text("payload_json"),
  errorMessage: text("error_message"),
  status: text("status").default("pending_retry"),
  correlationId: text("correlation_id"),
  createdAt: text("created_at").default("(datetime('now'))"),
  updatedAt: text("updated_at").default("(datetime('now'))"),
  retryCount: integer("retry_count").default(0),
});

// ---- Listing Records ----
export const listingRecords = sqliteTable("listing_records", {
  id: text("id").primaryKey(),
  sourceUrl: text("source_url"),
  status: text("status").notNull(),
  draftId: text("draft_id"),
  ozonProductId: integer("ozon_product_id"),
  correlationId: text("correlation_id"),
  resultJson: text("result_json"),
  createdAt: text("created_at").default("(datetime('now'))"),
});

// ---- Price History ----
export const priceHistory = sqliteTable("price_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productSku: text("product_sku"),
  platform: text("platform").notNull(),
  priceRub: real("price_rub").notNull(),
  sourceUrl: text("source_url"),
  capturedAt: text("captured_at").default("(datetime('now'))"),
});

// ---- Store Configs ----
export const storeConfigs = sqliteTable("store_configs", {
  storeId: text("store_id").primaryKey(),
  clientId: text("client_id").notNull(),
  apiKey: text("api_key").notNull(),
  storeName: text("store_name"),
  proxyUrl: text("proxy_url"),
  active: integer("active").default(1),
  createdAt: text("created_at").default("(datetime('now'))"),
});

// ---- Stock Alerts (persisted inventory warnings) ----
export const stockAlerts = sqliteTable("stock_alerts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sku: integer("sku").notNull(),
  offerId: text("offer_id").notNull(),
  alertLevel: text("alert_level").notNull(), // normal | warning | critical
  currentStock: integer("current_stock").notNull().default(0),
  safetyStock: integer("safety_stock").notNull().default(5),
  suggestedOrderQty: integer("suggested_order_qty").default(0),
  resolved: integer("resolved").default(0), // 0=open, 1=resolved
  createdAt: text("created_at").default("(datetime('now'))"),
  resolvedAt: text("resolved_at"),
});

// ---- Aftersales Cases ----
export const aftersalesCases = sqliteTable("aftersales_cases", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  postingNumber: text("posting_number").notNull(),
  type: text("type").notNull(), // refund | return | exchange | complaint | question
  status: text("status").notNull().default("pending"), // pending | processing | resolved | rejected
  reason: text("reason").notNull().default("other"),
  description: text("description"),
  buyerName: text("buyer_name"),
  buyerMessage: text("buyer_message"),
  refundAmountRub: real("refund_amount_rub"),
  resolutionNote: text("resolution_note"),
  attachmentsJson: text("attachments_json"),
  createdAt: text("created_at").default("(datetime('now'))"),
  updatedAt: text("updated_at").default("(datetime('now'))"),
});

// ---- Daily Sales Aggregation ----
export const dailySales = sqliteTable("daily_sales", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull().unique(),
  orders: integer("orders").notNull().default(0),
  revenueRub: real("revenue_rub").notNull().default(0),
  profitRub: real("profit_rub").notNull().default(0),
  avgOrderValue: real("avg_order_value").default(0),
  updatedAt: text("updated_at").default("(datetime('now'))"),
});

// ---- Product Performance ----
export const productPerformance = sqliteTable("product_performance", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id"),
  title: text("title"),
  sku: integer("sku").notNull(),
  sales: integer("sales").notNull().default(0),
  revenueRub: real("revenue_rub").notNull().default(0),
  profitRub: real("profit_rub").notNull().default(0),
  margin: real("margin").default(0),
  stock: integer("stock").default(0),
  rating: real("rating").default(0),
  reviewCount: integer("review_count").default(0),
  updatedAt: text("updated_at").default("(datetime('now'))"),
});

// ---- Market Snapshots (Ozon category data snapshots) ----
export const marketSnapshots = sqliteTable("market_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  categoryId: integer("category_id").notNull(),
  categoryName: text("category_name"),
  listingCount: integer("listing_count").default(0),
  avgPriceRub: real("avg_price_rub").default(0),
  minPriceRub: real("min_price_rub").default(0),
  maxPriceRub: real("max_price_rub").default(0),
  capturedAt: text("captured_at").default("(datetime('now'))"),
});

// ---- Category Opportunities (cached blue-ocean results) ----
export const categoryOpportunities = sqliteTable("category_opportunities", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  categoryId: integer("category_id").notNull().unique(),
  categoryName: text("category_name"),
  overallScore: integer("overall_score").default(0),
  listingCount: integer("listing_count").default(0),
  avgPriceRub: real("avg_price_rub").default(0),
  estMargin: integer("est_margin").default(0),
  monthOrders: integer("month_orders").default(0),
  recommendation: text("recommendation"),
  dataSource: text("data_source"),
  updatedAt: text("updated_at").default("(datetime('now'))"),
});
