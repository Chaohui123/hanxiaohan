// ============================================================
// Drizzle ORM Schema — PostgreSQL (migrated from SQLite)
// ============================================================

import { pgTable, text, integer, real, serial, timestamp } from "drizzle-orm/pg-core";

// ---- Task Queue ----
export const taskQueue = pgTable("task_queue", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  status: text("status").notNull().default("queued"),
  payloadJson: text("payload_json"),
  correlationId: text("correlation_id"),
  storeId: text("store_id").notNull().default("store_1"),
  createdAt: timestamp("created_at").defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  errorMessage: text("error_message"),
  retryCount: integer("retry_count").default(0),
  maxRetries: integer("max_retries").default(3),
  priority: integer("priority").default(0),
});

// ---- Failed Tasks ----
export const failedTasks = pgTable("failed_tasks", {
  id: text("id").primaryKey(),
  storeId: text("store_id").notNull(),
  taskType: text("task_type").notNull(),
  payloadJson: text("payload_json"),
  errorMessage: text("error_message"),
  status: text("status").default("pending_retry"),
  correlationId: text("correlation_id"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  retryCount: integer("retry_count").default(0),
});

// ---- Listing Records ----
export const listingRecords = pgTable("listing_records", {
  id: text("id").primaryKey(),
  sourceUrl: text("source_url"),
  status: text("status").notNull(),
  draftId: text("draft_id"),
  ozonProductId: integer("ozon_product_id"),
  correlationId: text("correlation_id"),
  resultJson: text("result_json"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---- Price History ----
export const priceHistory = pgTable("price_history", {
  id: serial("id").primaryKey(),
  productSku: text("product_sku"),
  platform: text("platform").notNull(),
  priceRub: real("price_rub").notNull(),
  sourceUrl: text("source_url"),
  capturedAt: timestamp("captured_at").defaultNow(),
});

// ---- Store Configs ----
export const storeConfigs = pgTable("store_configs", {
  storeId: text("store_id").primaryKey(),
  clientId: text("client_id").notNull(),
  apiKey: text("api_key").notNull(),
  storeName: text("store_name"),
  proxyUrl: text("proxy_url"),
  groupName: text("group_name"),
  active: integer("active").default(1),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---- Stock Alerts ----
export const stockAlerts = pgTable("stock_alerts", {
  id: serial("id").primaryKey(),
  sku: integer("sku").notNull(),
  offerId: text("offer_id").notNull(),
  alertLevel: text("alert_level").notNull(),
  currentStock: integer("current_stock").default(0),
  safetyStock: integer("safety_stock").default(5),
  suggestedOrderQty: integer("suggested_order_qty").default(0),
  resolved: integer("resolved").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  resolvedAt: timestamp("resolved_at"),
});

// ---- Aftersales Cases ----
export const aftersalesCases = pgTable("aftersales_cases", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  postingNumber: text("posting_number").notNull(),
  type: text("type").notNull(),
  status: text("status").notNull().default("pending"),
  reason: text("reason").default("other"),
  description: text("description"),
  buyerName: text("buyer_name"),
  buyerMessage: text("buyer_message"),
  refundAmountRub: real("refund_amount_rub"),
  resolutionNote: text("resolution_note"),
  attachmentsJson: text("attachments_json"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ---- Daily Sales ----
export const dailySales = pgTable("daily_sales", {
  id: serial("id").primaryKey(),
  date: text("date").notNull().unique(),
  orders: integer("orders").default(0),
  revenueRub: real("revenue_rub").default(0),
  profitRub: real("profit_rub").default(0),
  avgOrderValue: real("avg_order_value").default(0),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ---- Product Performance ----
export const productPerformance = pgTable("product_performance", {
  id: serial("id").primaryKey(),
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
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ---- Market Snapshots ----
export const marketSnapshots = pgTable("market_snapshots", {
  id: serial("id").primaryKey(),
  categoryId: integer("category_id").notNull(),
  categoryName: text("category_name"),
  listingCount: integer("listing_count").default(0),
  avgPriceRub: real("avg_price_rub").default(0),
  minPriceRub: real("min_price_rub").default(0),
  maxPriceRub: real("max_price_rub").default(0),
  capturedAt: timestamp("captured_at").defaultNow(),
});

// ---- Category Opportunities ----
export const categoryOpportunities = pgTable("category_opportunities", {
  id: serial("id").primaryKey(),
  categoryId: integer("category_id").notNull().unique(),
  categoryName: text("category_name"),
  overallScore: integer("overall_score").default(0),
  listingCount: integer("listing_count").default(0),
  avgPriceRub: real("avg_price_rub").default(0),
  estMargin: integer("est_margin").default(0),
  monthOrders: integer("month_orders").default(0),
  recommendation: text("recommendation"),
  dataSource: text("data_source"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ---- COS Image Records (cos-uploader.ts) ----
export const images = pgTable("images", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull(),
  cosKey: text("cos_key").notNull(),
  url: text("url"),
  status: text("status").notNull().default("pending"),
  retryCount: integer("retry_count").default(0),
  deadLetter: integer("dead_letter").default(0),
  localPath: text("local_path"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ---- Reconciliation Results (finance reconciler) ----
export const reconciliationResults = pgTable("reconciliation_results", {
  id: serial("id").primaryKey(),
  dateFrom: text("date_from").notNull(),
  dateTo: text("date_to").notNull(),
  totalOrders: integer("total_orders").default(0),
  matched: integer("matched").default(0),
  discrepancies: integer("discrepancies").default(0),
  missingLocal: integer("missing_local").default(0),
  missingOzon: integer("missing_ozon").default(0),
  resultJson: text("result_json"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---- Promo Agent: Watch List ----
export const promoWatchList = pgTable("promo_watch_list", {
  offerId: text("offer_id").primaryKey(),
  name: text("name").notNull(),
  addedAt: timestamp("added_at").defaultNow(),
});

// ---- Promo Agent: Competitor Prices ----
export const promoCompetitorPrices = pgTable("promo_competitor_prices", {
  id: serial("id").primaryKey(),
  offerId: text("offer_id").notNull(),
  price: real("price").notNull(),
  rating: real("rating").default(0),
  salesCount: integer("sales_count").default(0),
  capturedAt: timestamp("captured_at").defaultNow(),
});

// ---- Promo Agent: Events ----
export const promoEvents = pgTable("promo_events", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(),
  payloadJson: text("payload_json"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---- Promo Agent: Pricing History ----
export const promoPricingHistory = pgTable("promo_pricing_history", {
  id: serial("id").primaryKey(),
  offerId: text("offer_id").notNull(),
  name: text("name"),
  oldPrice: real("old_price"),
  newPrice: real("new_price"),
  reason: text("reason"),
  salesBefore: integer("sales_before").default(0),
  salesAfter7d: integer("sales_after_7d").default(0),
  appliedAt: timestamp("applied_at").defaultNow(),
});

// ---- Promo Agent: Copy History ----
export const promoCopyHistory = pgTable("promo_copy_history", {
  id: serial("id").primaryKey(),
  offerId: text("offer_id").notNull(),
  name: text("name"),
  titleRu: text("title_ru"),
  salesBefore: integer("sales_before").default(0),
  salesAfter7d: integer("sales_after_7d").default(0),
  appliedAt: timestamp("applied_at").defaultNow(),
});

// ---- Promo Agent: Decision Plans ----
export const promoDecisions = pgTable("promo_decisions", {
  id: text("id").primaryKey(),
  planJson: text("plan_json").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow(),
  executedAt: timestamp("executed_at"),
});

// ---- Promo Agent: Audit Log ----
export const promoAuditLog = pgTable("promo_audit_log", {
  id: serial("id").primaryKey(),
  actionType: text("action_type").notNull(),
  offerId: text("offer_id"),
  detailsJson: text("details_json"),
  operator: text("operator").default("auto"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---- RAG Knowledge Base Tables ----
// Note: embedding fields use text type in Drizzle (PG native vector type accessed via sql``)

export const ragAftersalesScripts = pgTable("rag_aftersales_scripts", {
  id: text("id").primaryKey(),
  category: text("category").notNull(),
  scenario: text("scenario").notNull(),
  contentRu: text("content_ru").notNull(),
  contentZh: text("content_zh"),
  keywords: text("keywords").array(),
  embedding: text("embedding"),
  source: text("source").default("manual"),
  effectivenessScore: real("effectiveness_score").default(0),
  usageCount: integer("usage_count").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const ragCompetitorReports = pgTable("rag_competitor_reports", {
  id: text("id").primaryKey(),
  offerId: text("offer_id").notNull(),
  categoryId: integer("category_id"),
  reportText: text("report_text").notNull(),
  priceTrendSummary: text("price_trend_summary"),
  actionSuggestion: text("action_suggestion"),
  embedding: text("embedding"),
  periodStart: text("period_start"),
  periodEnd: text("period_end"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const ragProductKnowledge = pgTable("rag_product_knowledge", {
  id: text("id").primaryKey(),
  categoryId: integer("category_id"),
  categoryName: text("category_name"),
  title: text("title").notNull(),
  content: text("content").notNull(),
  sourceUrl: text("source_url"),
  keywords: text("keywords").array(),
  embedding: text("embedding"),
  dataSource: text("data_source").default("scraper"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const ragCopyTemplates = pgTable("rag_copy_templates", {
  id: text("id").primaryKey(),
  category: text("category").notNull(),
  categoryId: integer("category_id"),
  originalText: text("original_text").notNull(),
  optimizedText: text("optimized_text"),
  optimizationNotes: text("optimization_notes"),
  embedding: text("embedding"),
  performanceScore: real("performance_score").default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const ragOperationsPlaybook = pgTable("rag_operations_playbook", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  scenario: text("scenario").notNull(),
  content: text("content").notNull(),
  tags: text("tags").array(),
  embedding: text("embedding"),
  author: text("author").default("system"),
  priority: integer("priority").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
