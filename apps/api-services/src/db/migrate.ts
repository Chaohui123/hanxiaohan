// ============================================================
// SQLite Migration Runner
// Versioned SQL migrations with an applied-migrations tracking table.
// Idempotent: runs each migration exactly once.
// Usage: await runMigrations(db) on startup.
// ============================================================

import type { DbAdapter } from "./connection.js";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Run pending migrations against the database.
 * Creates a `_migrations` tracking table if it doesn't exist.
 * Each migration runs in its own transaction.
 */
export async function runMigrations(db: DbAdapter, migrations: Migration[]): Promise<number> {
  // Ensure tracking table exists
  await db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Get already-applied versions
  const applied = await db.all<{ version: number }>(
    "SELECT version FROM _migrations ORDER BY version"
  );
  const appliedVersions = new Set(applied.map((r) => r.version));

  // Sort migrations by version
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  let appliedCount = 0;

  for (const migration of sorted) {
    if (appliedVersions.has(migration.version)) continue;

    console.log(`[Migration] Applying v${migration.version}: ${migration.name}`);

    try {
      await db.run("BEGIN IMMEDIATE");
      await db.exec(migration.sql);
      await db.run(
        "INSERT INTO _migrations (version, name) VALUES (?, ?)",
        [migration.version, migration.name]
      );
      await db.run("COMMIT");
      appliedCount++;
      console.log(`[Migration] ✓ v${migration.version}: ${migration.name}`);
    } catch (err) {
      await db.run("ROLLBACK").catch(() => {});
      console.error(`[Migration] ✗ v${migration.version}: ${migration.name} — ${(err as Error).message}`);
      throw err;
    }
  }

  return appliedCount;
}
