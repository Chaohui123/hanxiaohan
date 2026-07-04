// ============================================================
// PostgreSQL Connection Manager — pg Pool
// Migrated from SQLite. PG natively supports concurrent writes.
// ============================================================

import pg from "pg";
import { logger } from "@onzo/logger";
import { initSchema } from "./schema.js";

// ---- DbAdapter Interface (unchanged from SQLite — all services use this) ----
export interface DbAdapter {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid?: number | bigint }>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

let pool: pg.Pool | null = null;

function getDatabaseUrl(): string {
  return process.env.DATABASE_URL || "postgresql://onzo:onzo@localhost:5432/onzo_prod";
}

/**
 * Get or create the PostgreSQL connection pool.
 * Automatically initializes schema on first connection.
 */
export async function getDb(): Promise<DbAdapter | null> {
  if (pool) return createAdapter(pool);

  try {
    const url = getDatabaseUrl();
    pool = new pg.Pool({
      connectionString: url,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    // Test connection
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();

    // Init schema
    await initSchema(createAdapter(pool));

    logger.info({ db: "PostgreSQL", pool: "connected" }, "Database connected");
    return createAdapter(pool);
  } catch (err) {
    logger.error({ err: (err as Error).message }, "PostgreSQL connection failed — running without persistence");
    pool = null;
    return null;
  }
}

/**
 * Create a DbAdapter from pg Pool.
 * Converts SQLite-style ? placeholders to PG-style $1, $2, ...
 * Supports both parameter styles for backward compatibility.
 */
function createAdapter(p: pg.Pool): DbAdapter {
  let paramIndex = 0;

  function convertQuery(sql: string): string {
    paramIndex = 0;
    // Convert ? → $1, $2, ... only for non-PG queries
    if (sql.includes("$1") || sql.includes("$2")) return sql;
    return sql.replace(/\?/g, () => `$${++paramIndex}`);
  }

  return {
    async exec(sql: string): Promise<void> {
      const client = await p.connect();
      try {
        await client.query(sql);
      } finally {
        client.release();
      }
    },

    async run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid?: number | bigint }> {
      const client = await p.connect();
      try {
        const result = await client.query(convertQuery(sql), params || []);
        return { changes: result.rowCount ?? 0 };
      } finally {
        client.release();
      }
    },

    async all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      const client = await p.connect();
      try {
        const result = await client.query(convertQuery(sql), params || []);
        return result.rows as T[];
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Serialized write — no longer needed for PG (native concurrency).
 * Kept for backward compatibility with existing service code.
 */
export async function serializedWrite<T>(fn: () => Promise<T>): Promise<T> {
  return fn(); // PG handles concurrency natively
}

/**
 * Close the pool (for graceful shutdown).
 */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
