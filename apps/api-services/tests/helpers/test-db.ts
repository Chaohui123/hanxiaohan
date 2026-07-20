// Test helper — in-memory DB adapter for unit tests
import Database from "better-sqlite3";
import type { DbAdapter } from "../../src/db/connection.js";

export function createTestDb(): DbAdapter {
  const rows = new Map<string, Record<string, unknown>[]>();
  return {
    async exec(sql: string): Promise<void> {
      if (sql.includes("CREATE TABLE")) {
        const match = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
        if (match && !rows.has(match[1])) rows.set(match[1], []);
      }
    },
    async run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid?: number | bigint }> {
      if (sql.includes("BEGIN") || sql.includes("COMMIT") || sql.includes("ROLLBACK")) return { changes: 0 };
      if (sql.includes("INSERT OR REPLACE") || sql.includes("INSERT")) {
        const table = sql.match(/INTO\s+(\w+)/)?.[1] || "default";
        if (!rows.has(table)) rows.set(table, []);
        rows.get(table)!.push({ ...params } as unknown as Record<string, unknown>);
        return { changes: 1, lastInsertRowid: BigInt(rows.get(table)!.length) };
      }
      return { changes: 1 };
    },
    async all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      const table = sql.match(/FROM\s+(\w+)/)?.[1] || "default";
      const tableRows = rows.get(table) || [];
      return tableRows as T[];
    },
  };
}

// ---- Real in-memory SQLite adapter (better-sqlite3) ----
// Executes actual SQL — prefer this over string-matching fakes when the code
// under test builds WHERE/ORDER BY/LIMIT clauses or relies on parameter binding.

export interface SqliteTestDb {
  /** Raw better-sqlite3 handle — use for DDL, seeding, and row assertions. */
  db: Database.Database;
  /** DbAdapter view to hand to the code under test (e.g. a mocked getDb). */
  adapter: DbAdapter;
  close(): void;
}

export function createSqliteTestDb(): SqliteTestDb {
  const db = new Database(":memory:");

  // Mirror of sqliteCompat() in src/db/connection.ts: route SQL is written for
  // PG, so the same PG→SQLite translation must happen here.
  function sqliteCompat(sql: string): string {
    return sql.replace(/\bNOW\(\)/g, "datetime('now')").replace(/\$\d+/g, "?");
  }

  const adapter: DbAdapter = {
    async exec(sql: string): Promise<void> {
      db.exec(sqliteCompat(sql));
    },
    async run(sql: string, params: unknown[] = []) {
      const result = db.prepare(sqliteCompat(sql)).run(...params);
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    },
    async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sqliteCompat(sql)).all(...params) as T[];
    },
  };

  return { db, adapter, close: () => db.close() };
}

export function createMockOzonClient() {
  return {
    get apiBaseUrl() { return "https://api-seller.ozon.ru"; },
    getCategoryTree: async () => [{ categoryId: 100, title: "Test", children: [] }],
    getCategoryAttributes: async () => [{ id: 1, name: "Color", type: "string", isRequired: true }],
    importImageByUrl: async () => ({ id: "img-001", fileName: "1.jpg" }),
    importImageByUrlSoft: async () => ({ id: "img-001", fileName: "1.jpg" }),
    createDraft: async () => ({ productId: 12345, offerId: "OFFER-001", status: "draft" }),
    ping: async () => true,
    resetBreaker: () => {},
  };
}

export function createMockAiClient() {
  return {
    chatCompletion: async () => ({
      content: '{"translated":"ok"}',
      parsed: { titleRu: "Товар", descriptionRu: "Описание" },
      tokensUsed: { prompt: 10, completion: 5, total: 15 },
      model: "deepseek-v4-flash",
    }),
  };
}
