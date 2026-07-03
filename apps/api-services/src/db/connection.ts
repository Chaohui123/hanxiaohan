// ============================================================
// SQLite connection manager — singleton + write serialization
// Adapts between Node 22+ built-in DatabaseSync and better-sqlite3
// ============================================================

import { initSchema } from "./schema.js";

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
    const dbPath = process.env.SQLITE_DB_PATH || "./data/onzo.db";
    dbInstance = await createNodeSqliteAdapter(dbPath);
    await initSchema(dbInstance);
    console.log(`[DB] SQLite (node:sqlite) connected: ${dbPath}`);
  } catch (err) {
    console.warn("[DB] node:sqlite failed:", (err as Error).message);
    try {
      const dbPath = process.env.SQLITE_DB_PATH || "./data/onzo.db";
      dbInstance = await createBetterSqlite3Adapter(dbPath);
      await initSchema(dbInstance);
      console.log(`[DB] better-sqlite3 connected: ${dbPath}`);
    } catch {
      console.error("[DB] No SQLite driver available. Running without persistence.");
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
