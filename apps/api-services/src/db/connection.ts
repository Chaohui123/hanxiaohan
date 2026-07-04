// ============================================================
// SQLite connection manager — singleton + write serialization
// Adapts between Node 22+ built-in DatabaseSync and better-sqlite3
// ============================================================

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initSchema } from "./schema.js";
import { runMigrations } from "./migrate.js";
import { MIGRATIONS } from "./migrations.js";
import { logger } from "@onzo/logger";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../../../..");

function resolveDbPath(): string {
  const raw = process.env.SQLITE_DB_PATH || "./data/onzo.db";
  if (raw.startsWith("./") || raw.startsWith("../")) {
    return resolve(projectRoot, raw);
  }
  return raw;
}

// ---- Adapter interface ----
export interface DbAdapter {
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid?: number | bigint }>;
  all<T = Record<string, unknown>>(sql: string,params?: unknown[]): Promise<T[]>;
}

let dbInstance: DbAdapter | null = null;
let writeQueue: Array<() => Promise<void>> = [];
let writeLock = false;

/**
 * Create a DbAdapter from Node 22+ built-in DatabaseSync.
 */
async function createNodeSqliteAdapter(path: string): Promise<DbAdapter> {
  const sqlite = await import("node:sqlite");
  const db = new sqlite.DatabaseSync(path);

  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    async run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid?: number | bigint }> {
      const stmt = db.prepare(sql);
      return stmt.run(...(params ?? []));
    },
    async all<T = Record<string, unknown>>(sql: string,params?: unknown[]): Promise<T[]> {
      const stmt = db.prepare(sql);
      return stmt.all(...(params ?? [])) as T[];
    },
  };
}

/**
 * Create a DbAdapter from better-sqlite3 (fallback).
 */
async function createBetterSqlite3Adapter(path: string): Promise<DbAdapter> {
  const BetterSqlite3 = (await import("better-sqlite3")).default;
  const db = new BetterSqlite3(path);

  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    async run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid?: number | bigint }> {
      return db.prepare(sql).run(...(params ?? []));
    },
    async all<T = Record<string, unknown>>(sql: string,params?: unknown[]): Promise<T[]> {
      return db.prepare(sql).all(...(params ?? [])) as T[];
    },
  };
}

/**
 * Get or create the SQLite database connection (with adapter).
 */
export async function getDb(): Promise<DbAdapter | null> {
  if (dbInstance) return dbInstance;

  try {
    // Node 22+ built-in SQLite
    const dbPath = resolveDbPath();
    dbInstance = await createNodeSqliteAdapter(dbPath);
    await initSchema(dbInstance);
    const applied = await runMigrations(dbInstance, MIGRATIONS);
    if (applied > 0) logger.info({ applied }, "Database migrations complete");
    logger.info({ dbPath, driver: "node:sqlite" }, "SQLite connected");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "node:sqlite unavailable, trying better-sqlite3");
    try {
      const dbPath = resolveDbPath();
      dbInstance = await createBetterSqlite3Adapter(dbPath);
      await initSchema(dbInstance);
      const applied = await runMigrations(dbInstance, MIGRATIONS);
      if (applied > 0) logger.info({ applied }, "Database migrations complete");
      logger.info({ dbPath, driver: "better-sqlite3" }, "SQLite connected");
    } catch {
      logger.error("No SQLite driver available — running without persistence");
      dbInstance = null;
    }
  }

  return dbInstance;
}

/**
 * Serialize writes to avoid SQLite lock conflicts.
 */
export async function serializedWrite<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const execute = async () => {
      writeLock = true;
      try {
        const result = await fn();
        resolve(result);
      } catch (err) {
        reject(err);
      } finally {
        writeLock = false;
        const next = writeQueue.shift();
        if (next) next();
      }
    };

    if (!writeLock) {
      execute();
    } else {
      writeQueue.push(execute);
    }
  });
}
