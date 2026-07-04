// ============================================================
// Database Migrations — PostgreSQL DDL
// Migration tracking: _migrations table
// ============================================================

import type { Migration } from "./migrate.js";

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial-schema-postgresql",
    sql: `
      CREATE TABLE IF NOT EXISTS task_queue (
        id TEXT PRIMARY KEY, type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued', payload_json TEXT,
        correlation_id TEXT, store_id TEXT NOT NULL DEFAULT 'store_1',
        created_at TIMESTAMP DEFAULT NOW(), started_at TIMESTAMP,
        completed_at TIMESTAMP, error_message TEXT,
        retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3,
        priority INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_task_queue_status ON task_queue(status, priority);
      CREATE INDEX IF NOT EXISTS idx_task_queue_type ON task_queue(type);

      CREATE TABLE IF NOT EXISTS failed_tasks (
        id TEXT PRIMARY KEY, store_id TEXT NOT NULL,
        task_type TEXT NOT NULL, payload_json TEXT,
        error_message TEXT, status TEXT DEFAULT 'pending_retry',
        correlation_id TEXT, created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(), retry_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS listing_records (
        id TEXT PRIMARY KEY, source_url TEXT,
        status TEXT NOT NULL, draft_id TEXT, ozon_product_id INTEGER,
        correlation_id TEXT, result_json TEXT, created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS price_history (
        id SERIAL PRIMARY KEY, product_sku TEXT,
        platform TEXT NOT NULL, price_rub REAL NOT NULL,
        source_url TEXT, captured_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_price_history_sku ON price_history(product_sku, platform);

      CREATE TABLE IF NOT EXISTS local_orders (
        id TEXT PRIMARY KEY, store_id TEXT NOT NULL DEFAULT 'store_1',
        posting_number TEXT UNIQUE NOT NULL, order_id INTEGER NOT NULL,
        status TEXT NOT NULL, created_at TIMESTAMP NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW(), buyer_name_masked TEXT,
        buyer_phone_masked TEXT, total_price_rub REAL DEFAULT 0,
        commission_rub REAL DEFAULT 0, payout_rub REAL DEFAULT 0,
        product_count INTEGER DEFAULT 0, tracking_number TEXT,
        raw_json TEXT, synced_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS webhook_events (
        event_id TEXT PRIMARY KEY, posting_number TEXT,
        event_type TEXT, created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS inventory (
        offer_id TEXT NOT NULL, sku INTEGER NOT NULL,
        stock_available INTEGER DEFAULT 0, stock_reserved INTEGER DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY (offer_id, sku)
      );

      CREATE TABLE IF NOT EXISTS stock_movements (
        id SERIAL PRIMARY KEY, posting_number TEXT NOT NULL,
        offer_id TEXT NOT NULL, sku INTEGER NOT NULL, quantity INTEGER NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('deduct','restore','confirm')),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS token_usage (
        id SERIAL PRIMARY KEY, model TEXT NOT NULL,
        prompt_tokens INTEGER DEFAULT 0, completion_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0, provider TEXT NOT NULL,
        cost_estimate REAL DEFAULT 0.0, timestamp TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS store_configs (
        store_id TEXT PRIMARY KEY, client_id TEXT NOT NULL,
        api_key TEXT NOT NULL, store_name TEXT, proxy_url TEXT,
        group_name TEXT, active INTEGER DEFAULT 1, created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS category_cache (
        id INTEGER PRIMARY KEY, tree_json TEXT NOT NULL,
        fetched_at TIMESTAMP NOT NULL, ttl_hours INTEGER NOT NULL DEFAULT 24
      );

      CREATE TABLE IF NOT EXISTS stock_alerts (
        id SERIAL PRIMARY KEY, sku INTEGER NOT NULL, offer_id TEXT NOT NULL,
        alert_level TEXT NOT NULL, current_stock INTEGER DEFAULT 0,
        safety_stock INTEGER DEFAULT 5, suggested_order_qty INTEGER DEFAULT 0,
        resolved INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW(),
        resolved_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS aftersales_cases (
        id TEXT PRIMARY KEY, order_id TEXT NOT NULL,
        posting_number TEXT NOT NULL, type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', reason TEXT DEFAULT 'other',
        description TEXT, buyer_name TEXT, buyer_message TEXT,
        refund_amount_rub REAL, resolution_note TEXT, attachments_json TEXT,
        created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS daily_sales (
        id SERIAL PRIMARY KEY, date TEXT UNIQUE NOT NULL,
        orders INTEGER DEFAULT 0, revenue_rub REAL DEFAULT 0,
        profit_rub REAL DEFAULT 0, avg_order_value REAL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS product_performance (
        id SERIAL PRIMARY KEY, product_id INTEGER, title TEXT,
        sku INTEGER NOT NULL, sales INTEGER DEFAULT 0,
        revenue_rub REAL DEFAULT 0, profit_rub REAL DEFAULT 0,
        margin REAL DEFAULT 0, stock INTEGER DEFAULT 0,
        rating REAL DEFAULT 0, review_count INTEGER DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS market_snapshots (
        id SERIAL PRIMARY KEY, category_id INTEGER NOT NULL,
        category_name TEXT, listing_count INTEGER DEFAULT 0,
        avg_price_rub REAL DEFAULT 0, min_price_rub REAL DEFAULT 0,
        max_price_rub REAL DEFAULT 0, captured_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS category_opportunities (
        id SERIAL PRIMARY KEY, category_id INTEGER NOT NULL UNIQUE,
        category_name TEXT, overall_score INTEGER DEFAULT 0,
        listing_count INTEGER DEFAULT 0, avg_price_rub REAL DEFAULT 0,
        est_margin INTEGER DEFAULT 0, month_orders INTEGER DEFAULT 0,
        recommendation TEXT, data_source TEXT, updated_at TIMESTAMP DEFAULT NOW()
      );
    `,
  },
];
