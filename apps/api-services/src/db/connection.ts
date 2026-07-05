// ============================================================
// Database Connection Manager — PG primary, SQLite fallback
// ============================================================

import pg from "pg";
import { logger } from "@onzo/logger";
import { initSchema } from "./schema.js";

// ---- DbAdapter Interface ----
export interface DbAdapter {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid?: number | bigint }>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

let pool: pg.Pool | null = null;
let sqliteDb: unknown = null; // lazy-loaded
let adapterType: "pg" | "sqlite" = "pg";

function getDatabaseUrl(): string {
  return process.env.DATABASE_URL || "postgresql://onzo:onzo@localhost:5432/onzo_prod";
}

export function getAdapterType(): string {
  return adapterType;
}

/**
 * Get or create the database connection.
 * Tries PostgreSQL first, falls back to SQLite for dev.
 */
export async function getDb(): Promise<DbAdapter | null> {
  if (pool) return createPgAdapter(pool);
  if (sqliteDb) return createSqliteAdapter(sqliteDb);

  // Try PostgreSQL first
  try {
    const url = getDatabaseUrl();
    pool = new pg.Pool({
      connectionString: url,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();

    await initSchema(createPgAdapter(pool));
    adapterType = "pg";
    logger.info({ db: "PostgreSQL" }, "Database connected");
    return createPgAdapter(pool);
  } catch (pgErr) {
    logger.warn({ err: (pgErr as Error).message }, "PostgreSQL unavailable, falling back to SQLite");
    if (pool) { await pool.end().catch(() => {}); pool = null; }
  }

  // Fallback to SQLite
  try {
    const Database = (await import("better-sqlite3")).default;
    const dbPath = process.env.SQLITE_DB_PATH || "./data/onzo.db";
    const { mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(dbPath), { recursive: true });

    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");

    await initSqliteSchema(db);
    sqliteDb = db;
    adapterType = "sqlite";
    logger.info({ db: "SQLite", path: dbPath }, "Database connected (fallback)");
    return createSqliteAdapter(db);
  } catch (sqliteErr) {
    logger.error({ err: (sqliteErr as Error).message }, "SQLite fallback also failed");
    return null;
  }
}

// ---- SQLite Schema Init ----

function initSqliteSchema(db: unknown): void {
  const d = db as { exec: (sql: string) => void };
  d.exec(`
    CREATE TABLE IF NOT EXISTS promo_watch_list (
      offer_id TEXT PRIMARY KEY, name TEXT NOT NULL,
      added_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS promo_competitor_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, offer_id TEXT NOT NULL,
      price REAL NOT NULL, rating REAL DEFAULT 0,
      sales_count INTEGER DEFAULT 0, captured_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_comp_prices_offer ON promo_competitor_prices(offer_id, captured_at);
    CREATE TABLE IF NOT EXISTS promo_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL,
      payload_json TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_promo_events_type ON promo_events(type);
    CREATE TABLE IF NOT EXISTS promo_pricing_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, offer_id TEXT NOT NULL, name TEXT,
      old_price REAL, new_price REAL, reason TEXT,
      sales_before INTEGER DEFAULT 0, sales_after_7d INTEGER DEFAULT 0,
      applied_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS promo_copy_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, offer_id TEXT NOT NULL, name TEXT,
      title_ru TEXT, sales_before INTEGER DEFAULT 0, sales_after_7d INTEGER DEFAULT 0,
      applied_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS promo_decisions (
      id TEXT PRIMARY KEY, plan_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')), executed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS promo_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action_type TEXT NOT NULL,
      offer_id TEXT, details_json TEXT,
      operator TEXT DEFAULT 'auto', created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS promo_ab_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      offer_id TEXT NOT NULL,
      strategy TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT,
      sales_before INTEGER DEFAULT 0,
      sales_after INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'running',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS rag_aftersales_scripts (
      id TEXT PRIMARY KEY, category TEXT NOT NULL,
      scenario TEXT NOT NULL, content_ru TEXT NOT NULL,
      content_zh TEXT, keywords TEXT,
      embedding TEXT, source TEXT DEFAULT 'manual',
      effectiveness_score REAL DEFAULT 0, usage_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS rag_competitor_reports (
      id TEXT PRIMARY KEY, offer_id TEXT NOT NULL,
      category_id INTEGER, report_text TEXT NOT NULL,
      price_trend_summary TEXT, action_suggestion TEXT,
      embedding TEXT, period_start TEXT, period_end TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS rag_product_knowledge (
      id TEXT PRIMARY KEY, category_id INTEGER, category_name TEXT,
      title TEXT NOT NULL, content TEXT NOT NULL, source_url TEXT,
      keywords TEXT, embedding TEXT,
      data_source TEXT DEFAULT 'scraper',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS rag_copy_templates (
      id TEXT PRIMARY KEY, category TEXT NOT NULL,
      category_id INTEGER, original_text TEXT NOT NULL,
      optimized_text TEXT, optimization_notes TEXT,
      embedding TEXT, performance_score REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS rag_operations_playbook (
      id TEXT PRIMARY KEY, title TEXT NOT NULL,
      scenario TEXT NOT NULL, content TEXT NOT NULL,
      tags TEXT, embedding TEXT,
      author TEXT DEFAULT 'system', priority INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS product_performance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER, title TEXT, sku INTEGER NOT NULL,
      sales INTEGER DEFAULT 0, revenue_rub REAL DEFAULT 0,
      profit_rub REAL DEFAULT 0, margin REAL DEFAULT 0,
      stock INTEGER DEFAULT 0, rating REAL DEFAULT 0,
      review_count INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS daily_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT UNIQUE NOT NULL,
      orders INTEGER DEFAULT 0, revenue_rub REAL DEFAULT 0,
      profit_rub REAL DEFAULT 0, avg_order_value REAL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT NOT NULL,
      prompt_tokens INTEGER DEFAULT 0, completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0, provider TEXT NOT NULL,
      cost_estimate REAL DEFAULT 0.0, timestamp TEXT DEFAULT (datetime('now'))
    );
  `);
}

// ---- PG Adapter ----

function createPgAdapter(p: pg.Pool): DbAdapter {
  let paramIndex = 0;

  function convertQuery(sql: string): string {
    paramIndex = 0;
    if (sql.includes("$1") || sql.includes("$2")) return sql;
    return sql.replace(/\?/g, () => `$${++paramIndex}`);
  }

  return {
    async exec(sql: string): Promise<void> {
      const client = await p.connect();
      try { await client.query(sql); } finally { client.release(); }
    },
    async run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid?: number | bigint }> {
      const client = await p.connect();
      try {
        const result = await client.query(convertQuery(sql), params || []);
        return { changes: result.rowCount ?? 0 };
      } finally { client.release(); }
    },
    async all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      const client = await p.connect();
      try {
        const result = await client.query(convertQuery(sql), params || []);
        return result.rows as T[];
      } finally { client.release(); }
    },
  };
}

// ---- SQLite Adapter ----

function createSqliteAdapter(db: unknown): DbAdapter {
  const d = db as {
    exec: (sql: string) => void;
    prepare: (sql: string) => {
      run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
      all: (...params: unknown[]) => unknown[];
    };
  };

  return {
    async exec(sql: string): Promise<void> {
      d.exec(sql);
    },
    async run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid?: number | bigint }> {
      const stmt = d.prepare(sql);
      const result = stmt.run(...(params || []));
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    },
    async all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      const stmt = d.prepare(sql);
      return stmt.all(...(params || [])) as T[];
    },
  };
}

export async function serializedWrite<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

export async function closeDb(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
  if (sqliteDb) {
    (sqliteDb as { close: () => void }).close();
    sqliteDb = null;
  }
}

export function getPoolStats(): { total: number; idle: number; waiting: number } {
  if (!pool) return { total: 0, idle: 0, waiting: 0 };
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
}
