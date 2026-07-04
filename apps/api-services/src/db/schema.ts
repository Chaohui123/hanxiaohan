// ============================================================
// SQLite schema initialization
// ============================================================

import type Database from "node:sqlite";

export async function initSchema(db: Database): Promise<void> {
  await db.exec(`
    -- Task queue (shared with @onzo/task-queue)
    CREATE TABLE IF NOT EXISTS task_queue (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      payload_json TEXT,
      correlation_id TEXT,
      store_id TEXT NOT NULL DEFAULT 'store_1',
      created_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      error_message TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 3,
      priority INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_task_queue_status ON task_queue(status, priority);
    CREATE INDEX IF NOT EXISTS idx_task_queue_type ON task_queue(type);

    -- Failed tasks (for manual retry from Web dashboard)
    CREATE TABLE IF NOT EXISTS failed_tasks (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      task_type TEXT NOT NULL,
      payload_json TEXT,
      error_message TEXT,
      status TEXT DEFAULT 'pending_retry',
      correlation_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      retry_count INTEGER DEFAULT 0
    );

    -- Listing records (success audit log)
    CREATE TABLE IF NOT EXISTS listing_records (
      id TEXT PRIMARY KEY,
      source_url TEXT,
      status TEXT NOT NULL,
      draft_id TEXT,
      ozon_product_id INTEGER,
      correlation_id TEXT,
      result_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Price history (P2 light alternative 鈥?no Qdrant needed in Phase 1)
    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_sku TEXT,
      platform TEXT NOT NULL,
      price_rub REAL NOT NULL,
      source_url TEXT,
      captured_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_price_history_sku ON price_history(product_sku, platform);

    -- Orders (synced from Ozon FBO/FBS)
    CREATE TABLE IF NOT EXISTS local_orders (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL DEFAULT 'store_1',
      posting_number TEXT UNIQUE NOT NULL,
      order_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      buyer_name_masked TEXT,
      buyer_phone_masked TEXT,
      total_price_rub REAL DEFAULT 0,
      commission_rub REAL DEFAULT 0,
      payout_rub REAL DEFAULT 0,
      product_count INTEGER DEFAULT 0,
      tracking_number TEXT,
      raw_json TEXT,
      synced_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_orders_status ON local_orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_posting ON local_orders(posting_number);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_store_order ON local_orders(store_id, order_id);

    -- Webhook event dedup (persisted to avoid duplicate processing after restart)
    CREATE TABLE IF NOT EXISTS webhook_events (
      event_id TEXT PRIMARY KEY,
      posting_number TEXT,
      event_type TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_events_posting ON webhook_events(posting_number);

    -- Inventory management
    CREATE TABLE IF NOT EXISTS inventory (
      offer_id TEXT NOT NULL,
      sku INTEGER NOT NULL,
      stock_available INTEGER DEFAULT 0,
      stock_reserved INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (offer_id, sku)
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      posting_number TEXT NOT NULL,
      offer_id TEXT NOT NULL,
      sku INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('deduct', 'restore', 'confirm')),
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_stock_mov_posting ON stock_movements(posting_number);

    -- Token usage tracking (LLM cost monitoring)
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      provider TEXT NOT NULL,
      cost_estimate REAL DEFAULT 0.0,
      timestamp TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_token_usage_date ON token_usage(date(timestamp));

    -- Store configs (multi-key management + grouping)
    CREATE TABLE IF NOT EXISTS store_configs (
      store_id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      api_key TEXT NOT NULL,
      store_name TEXT,
      proxy_url TEXT,
      group_name TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_store_group ON store_configs(group_name);

    -- Category tree cache (reduces Ozon API calls)
    CREATE TABLE IF NOT EXISTS category_cache (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      tree_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      ttl_hours INTEGER NOT NULL DEFAULT 24
    );
  `);
}

