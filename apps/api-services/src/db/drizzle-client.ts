// ============================================================
// Drizzle ORM Client — PostgreSQL via node-postgres
// Migrated from drizzle-orm/sqlite-proxy
// ============================================================

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./drizzle-schema.js";

let drizzleDb: ReturnType<typeof drizzle> | null = null;
let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL || "postgresql://onzo:onzo@localhost:5432/onzo_prod",
      max: 10,
    });
  }
  return pool;
}

/** Lazy-initialize Drizzle ORM backed by PostgreSQL */
export async function getDrizzle() {
  if (drizzleDb) return drizzleDb;

  const p = getPool();
  drizzleDb = drizzle(p, { schema });
  return drizzleDb;
}

/** Close the Drizzle pool */
export async function closeDrizzle(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
  drizzleDb = null;
}
