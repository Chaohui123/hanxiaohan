// ============================================================
// Drizzle ORM Client — PostgreSQL primary, SQLite fallback
// ============================================================

import pg from "pg";
import { logger } from "@onzo/logger";
import * as pgSchema from "./drizzle-schema.js";
import * as sqliteSchema from "./drizzle-schema-sqlite.js";

type DrizzlePg = ReturnType<typeof import("drizzle-orm/node-postgres").drizzle>;
type DrizzleSqlite = ReturnType<typeof import("drizzle-orm/better-sqlite3").drizzle>;

let drizzleDb: DrizzlePg | DrizzleSqlite | null = null;
let pool: pg.Pool | null = null;
let dbType: "pg" | "sqlite" = "pg";

export function getDrizzleType(): string {
  return dbType;
}

/** Lazy-initialize Drizzle ORM — PG first, SQLite fallback */
export async function getDrizzle(): Promise<DrizzlePg | DrizzleSqlite> {
  if (drizzleDb) return drizzleDb;

  // Try PostgreSQL first
  try {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const dbUrl = process.env.DATABASE_URL || "postgresql://onzo:onzo@localhost:5432/onzo_prod";
    pool = new pg.Pool({ connectionString: dbUrl, max: 10, connectionTimeoutMillis: 5000 });
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();

    drizzleDb = drizzle(pool, { schema: pgSchema });
    dbType = "pg";
    logger.info("Drizzle ORM initialized — PostgreSQL");
    return drizzleDb;
  } catch (pgErr) {
    logger.warn({ err: (pgErr as Error).message }, "Drizzle PG unavailable, falling back to SQLite");
    if (pool) { await pool.end().catch(() => {}); pool = null; }
  }

  // SQLite fallback
  try {
    const { drizzle } = await import("drizzle-orm/better-sqlite3");
    const Database = (await import("better-sqlite3")).default;
    const dbPath = process.env.SQLITE_DB_PATH || "./data/onzo.db";
    const { mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(dbPath), { recursive: true });

    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("busy_timeout = 5000");

    drizzleDb = drizzle(sqlite, { schema: sqliteSchema });
    dbType = "sqlite";
    logger.info("Drizzle ORM initialized — SQLite fallback");
    return drizzleDb;
  } catch (sqliteErr) {
    logger.error({ err: (sqliteErr as Error).message }, "Drizzle SQLite fallback also failed");
    throw sqliteErr;
  }
}

export async function closeDrizzle(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
  drizzleDb = null;
}
