// ============================================================
// PostgreSQL Schema Initialization
// ============================================================

import type { DbAdapter } from "./connection.js";
import { getAdapterType } from "./connection.js";

export async function initSchema(db: DbAdapter): Promise<void> {
  await db.exec(`
    -- Enable pgvector extension for RAG
    CREATE EXTENSION IF NOT EXISTS vector;

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
      correlation_id TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      retry_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS listing_records (
      id TEXT PRIMARY KEY, source_url TEXT,
      status TEXT NOT NULL, draft_id TEXT,
      ozon_product_id INTEGER, correlation_id TEXT,
      result_json TEXT, created_at TIMESTAMP DEFAULT NOW()
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
      updated_at TIMESTAMP DEFAULT NOW(),
      buyer_name_masked TEXT, buyer_phone_masked TEXT,
      total_price_rub REAL DEFAULT 0, commission_rub REAL DEFAULT 0,
      payout_rub REAL DEFAULT 0, product_count INTEGER DEFAULT 0,
      tracking_number TEXT, raw_json TEXT,
      synced_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_orders_status ON local_orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_posting ON local_orders(posting_number);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_store_order ON local_orders(store_id, order_id);

    CREATE TABLE IF NOT EXISTS webhook_events (
      event_id TEXT PRIMARY KEY, posting_number TEXT,
      event_type TEXT, created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_events_posting ON webhook_events(posting_number);

    CREATE TABLE IF NOT EXISTS inventory (
      offer_id TEXT NOT NULL, sku INTEGER NOT NULL,
      stock_available INTEGER DEFAULT 0, stock_reserved INTEGER DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (offer_id, sku)
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id SERIAL PRIMARY KEY, posting_number TEXT NOT NULL,
      offer_id TEXT NOT NULL, sku INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('deduct','restore','confirm')),
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_stock_mov_posting ON stock_movements(posting_number);

    CREATE TABLE IF NOT EXISTS token_usage (
      id SERIAL PRIMARY KEY, model TEXT NOT NULL,
      prompt_tokens INTEGER DEFAULT 0, completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0, provider TEXT NOT NULL,
      cost_estimate REAL DEFAULT 0.0, timestamp TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_token_usage_date ON token_usage(DATE(timestamp));

    CREATE TABLE IF NOT EXISTS store_configs (
      store_id TEXT PRIMARY KEY, client_id TEXT NOT NULL,
      api_key TEXT NOT NULL, store_name TEXT, proxy_url TEXT,
      group_name TEXT, active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_store_group ON store_configs(group_name);

    CREATE TABLE IF NOT EXISTS category_cache (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      tree_json TEXT NOT NULL, fetched_at TIMESTAMP NOT NULL,
      ttl_hours INTEGER NOT NULL DEFAULT 24
    );

    CREATE TABLE IF NOT EXISTS stock_alerts (
      id SERIAL PRIMARY KEY, sku INTEGER NOT NULL,
      offer_id TEXT NOT NULL, alert_level TEXT NOT NULL,
      current_stock INTEGER DEFAULT 0, safety_stock INTEGER DEFAULT 5,
      suggested_order_qty INTEGER DEFAULT 0, resolved INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(), resolved_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS aftersales_cases (
      id TEXT PRIMARY KEY, order_id TEXT NOT NULL,
      posting_number TEXT NOT NULL, type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reason TEXT DEFAULT 'other', description TEXT,
      buyer_name TEXT, buyer_message TEXT,
      refund_amount_rub REAL, resolution_note TEXT,
      attachments_json TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS daily_sales (
      id SERIAL PRIMARY KEY, date TEXT UNIQUE NOT NULL,
      orders INTEGER DEFAULT 0, revenue_rub REAL DEFAULT 0,
      profit_rub REAL DEFAULT 0, avg_order_value REAL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS product_performance (
      id SERIAL PRIMARY KEY, product_id INTEGER,
      title TEXT, sku INTEGER NOT NULL,
      sales INTEGER DEFAULT 0, revenue_rub REAL DEFAULT 0,
      profit_rub REAL DEFAULT 0, margin REAL DEFAULT 0,
      stock INTEGER DEFAULT 0, rating REAL DEFAULT 0,
      review_count INTEGER DEFAULT 0, updated_at TIMESTAMP DEFAULT NOW()
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
      recommendation TEXT, data_source TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    -- COS Image Records (cos-uploader.ts)
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      cos_key TEXT NOT NULL,
      url TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0,
      dead_letter INTEGER DEFAULT 0,
      local_path TEXT,
      error TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_images_product ON images(product_id);
    CREATE INDEX IF NOT EXISTS idx_images_status ON images(status);

    -- Reconciliation results
    CREATE TABLE IF NOT EXISTS reconciliation_results (
      id SERIAL PRIMARY KEY,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      total_orders INTEGER DEFAULT 0,
      matched INTEGER DEFAULT 0,
      discrepancies INTEGER DEFAULT 0,
      missing_local INTEGER DEFAULT 0,
      missing_ozon INTEGER DEFAULT 0,
      result_json TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    -- Promo Agent: watch list
    CREATE TABLE IF NOT EXISTS promo_watch_list (
      offer_id TEXT PRIMARY KEY, name TEXT NOT NULL,
      added_at TIMESTAMP DEFAULT NOW()
    );

    -- Promo Agent: competitor price snapshots
    CREATE TABLE IF NOT EXISTS promo_competitor_prices (
      id SERIAL PRIMARY KEY, offer_id TEXT NOT NULL,
      price REAL NOT NULL, rating REAL DEFAULT 0,
      sales_count INTEGER DEFAULT 0, captured_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_comp_prices_offer ON promo_competitor_prices(offer_id, captured_at);

    -- Promo Agent: events (scraper blocked, etc.)
    CREATE TABLE IF NOT EXISTS promo_events (
      id SERIAL PRIMARY KEY, type TEXT NOT NULL,
      payload_json TEXT, created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_promo_events_type ON promo_events(type);

    -- Promo Agent: pricing history
    CREATE TABLE IF NOT EXISTS promo_pricing_history (
      id SERIAL PRIMARY KEY, offer_id TEXT NOT NULL, name TEXT,
      old_price REAL, new_price REAL, reason TEXT,
      sales_before INTEGER DEFAULT 0, sales_after_7d INTEGER DEFAULT 0,
      applied_at TIMESTAMP DEFAULT NOW()
    );

    -- Promo Agent: copy optimization history
    CREATE TABLE IF NOT EXISTS promo_copy_history (
      id SERIAL PRIMARY KEY, offer_id TEXT NOT NULL, name TEXT,
      title_ru TEXT, sales_before INTEGER DEFAULT 0, sales_after_7d INTEGER DEFAULT 0,
      applied_at TIMESTAMP DEFAULT NOW()
    );

    -- Promo Agent: decision plans
    CREATE TABLE IF NOT EXISTS promo_decisions (
      id TEXT PRIMARY KEY, plan_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(), executed_at TIMESTAMP
    );

    -- Promo Agent: audit log
    CREATE TABLE IF NOT EXISTS promo_audit_log (
      id SERIAL PRIMARY KEY, action_type TEXT NOT NULL,
      offer_id TEXT, details_json TEXT,
      operator TEXT DEFAULT 'auto', created_at TIMESTAMP DEFAULT NOW()
    );

    -- Promo Agent: A/B test experiments
    CREATE TABLE IF NOT EXISTS promo_ab_tests (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      offer_id TEXT NOT NULL,
      strategy TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT,
      sales_before INTEGER DEFAULT 0,
      sales_after INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'running',
      created_at TIMESTAMP DEFAULT NOW()
    );

    -- RAG 知识库：售后话术
    CREATE TABLE IF NOT EXISTS rag_aftersales_scripts (
      id TEXT PRIMARY KEY, category TEXT NOT NULL,
      scenario TEXT NOT NULL, content_ru TEXT NOT NULL,
      content_zh TEXT, keywords TEXT[],
      embedding vector(2048), source TEXT DEFAULT 'manual',
      effectiveness_score REAL DEFAULT 0, usage_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
    );

    -- RAG 知识库：竞品分析报告
    CREATE TABLE IF NOT EXISTS rag_competitor_reports (
      id TEXT PRIMARY KEY, offer_id TEXT NOT NULL,
      category_id INTEGER, report_text TEXT NOT NULL,
      price_trend_summary TEXT, action_suggestion TEXT,
      embedding vector(2048), period_start TEXT, period_end TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    -- RAG 知识库：选品知识
    CREATE TABLE IF NOT EXISTS rag_product_knowledge (
      id TEXT PRIMARY KEY, category_id INTEGER, category_name TEXT,
      title TEXT NOT NULL, content TEXT NOT NULL, source_url TEXT,
      keywords TEXT[], embedding vector(2048),
      data_source TEXT DEFAULT 'scraper',
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
    );

    -- RAG 知识库：推广文案模板
    CREATE TABLE IF NOT EXISTS rag_copy_templates (
      id TEXT PRIMARY KEY, category TEXT NOT NULL,
      category_id INTEGER, original_text TEXT NOT NULL,
      optimized_text TEXT, optimization_notes TEXT,
      embedding vector(2048), performance_score REAL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );

    -- RAG 知识库：运营经验
    CREATE TABLE IF NOT EXISTS rag_operations_playbook (
      id TEXT PRIMARY KEY, title TEXT NOT NULL,
      scenario TEXT NOT NULL, content TEXT NOT NULL,
      tags TEXT[], embedding vector(2048),
      author TEXT DEFAULT 'system', priority INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
    );

  `);

  // Create IVFFlat indexes for RAG tables (PG only, silently skip if insufficient data)
  if (getAdapterType() === "pg") {
    const indexes = [
      `CREATE INDEX IF NOT EXISTS idx_rag_scripts_embedding ON rag_aftersales_scripts USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50)`,
      `CREATE INDEX IF NOT EXISTS idx_rag_competitor_embedding ON rag_competitor_reports USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50)`,
      `CREATE INDEX IF NOT EXISTS idx_rag_product_embedding ON rag_product_knowledge USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50)`,
      `CREATE INDEX IF NOT EXISTS idx_rag_copy_embedding ON rag_copy_templates USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50)`,
      `CREATE INDEX IF NOT EXISTS idx_rag_playbook_embedding ON rag_operations_playbook USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50)`,
    ];
    for (const idx of indexes) {
      try { await db.run(idx); } catch { /* insufficient data, will retry later */ }
    }
  }
}
