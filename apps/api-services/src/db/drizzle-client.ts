// ============================================================
// Drizzle ORM Runtime Client — sqlite-proxy adapter
// Wraps node:sqlite DatabaseSync via drizzle-orm/sqlite-proxy
// ============================================================

import { drizzle } from "drizzle-orm/sqlite-proxy";
import { count, sum, sql } from "drizzle-orm";
import * as schema from "./drizzle-schema.js";

let drizzleDb: ReturnType<typeof drizzle> | null = null;

/** Lazy-initialize Drizzle ORM backed by node:sqlite via proxy */
export async function getDrizzle() {
  if (drizzleDb) return drizzleDb;

  const sqlite = await import("node:sqlite");
  const rawDb = new sqlite.DatabaseSync(process.env.SQLITE_DB_PATH || "./data/onzo.db");

  drizzleDb = drizzle(
    async (query: string, params: unknown[], method: "run" | "all" | "get") => {
      const stmt = rawDb.prepare(query);
      if (method === "run") { stmt.run(...params); return { rows: [] }; }
      if (method === "get") { return { rows: [stmt.get(...params) ?? {}] }; }
      return { rows: stmt.all(...params) as Record<string, unknown>[] };
    },
    { schema }
  );

  return drizzleDb;
}

// ---- Typed Query Helpers ----

/** Get today's listing count */
export async function getTodayListingCount(): Promise<number> {
  try {
    const db = await getDrizzle();
    const today = new Date().toISOString().split("T")[0];
    const rows = await db
      .select({ cnt: count() })
      .from(schema.listingRecords)
      .where(sql`date(${schema.listingRecords.createdAt}) = ${today}`);
    return rows[0]?.cnt ?? 0;
  } catch { return 0; }
}

/** Get pending order count */
export async function getPendingOrderCount(): Promise<number> {
  try {
    const db = await getDrizzle();
    const rows = await db
      .select({ cnt: count() })
      .from(schema.localOrders)
      .where(sql`${schema.localOrders.status} IN ('awaiting_packaging','awaiting_deliver','delivering')`);
    return rows[0]?.cnt ?? 0;
  } catch { return 0; }
}

/** Get today's token total */
export async function getTodayTokenTotal(): Promise<number> {
  try {
    const db = await getDrizzle();
    const today = new Date().toISOString().split("T")[0];
    const rows = await db
      .select({ total: sum(schema.tokenUsage.totalTokens) })
      .from(schema.tokenUsage)
      .where(sql`date(${schema.tokenUsage.timestamp}) = ${today}`);
    return Number(rows[0]?.total) || 0;
  } catch { return 0; }
}
