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
