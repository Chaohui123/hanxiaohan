import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeDb, getDb } from "../src/db/connection.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join("temp", "search-analytics-init-"));
  process.env.DATABASE_URL = "postgresql://127.0.0.1:1/onzo_init_test";
  process.env.SQLITE_DB_PATH = path.join(directory, "init.db");
});

afterEach(async () => {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
});

describe("real database initialization", () => {
  it("creates search tables through the real SQLite fallback", async () => {
    const db = await getDb();
    expect(db).not.toBeNull();
    const tables = await db!.all<{ name: string; sql: string }>("SELECT name,sql FROM sqlite_master WHERE name LIKE 'ozon_search_%' ORDER BY name");
    expect(tables.map(table => table.name)).toEqual([
      "ozon_search_collection_runs", "ozon_search_derived_windows", "ozon_search_query_snapshots", "ozon_search_raw_responses",
    ]);
    expect(tables.find(table => table.name === "ozon_search_collection_runs")?.sql).toContain("datetime('now')");
  });
});
