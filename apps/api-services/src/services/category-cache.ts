// ============================================================
// Ozon Category Tree Cache — SQLite-backed with TTL
// Reduces Ozon API calls from every listing to every 24h
// ============================================================

import type { OzonCategoryNode } from "@onzo/shared-types";
import type { OzonClient } from "@onzo/ozon-api-wrapper";
import { getDb } from "../db/connection.js";
import { logger } from "@onzo/logger";

const CACHE_TABLE = `
  CREATE TABLE IF NOT EXISTS category_cache (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    tree_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    ttl_hours INTEGER NOT NULL DEFAULT 24
  )
`;

let tableCreated = false;

async function ensureTable(): Promise<void> {
  if (tableCreated) return;
  const db = await getDb();
  if (db) {
    await db.exec(CACHE_TABLE);
    tableCreated = true;
  }
}

interface CachedTree {
  tree: OzonCategoryNode[];
  fetchedAt: string;
  ttlHours: number;
}

/**
 * Get category tree — from cache if fresh, otherwise fetch from Ozon API.
 */
export async function getCategoryTree(
  ozonClient: OzonClient,
  options?: { ttlHours?: number; forceRefresh?: boolean }
): Promise<OzonCategoryNode[]> {
  const ttlHours = options?.ttlHours ?? 24;

  await ensureTable();
  const db = await getDb();

  // Check cache
  if (!options?.forceRefresh && db) {
    try {
      const rows = await db.all(
        "SELECT tree_json, fetched_at FROM category_cache WHERE id = 1 AND datetime(fetched_at, ? || ' hours') > datetime('now')",
        [String(ttlHours)]
      ) as Array<{ tree_json: string; fetched_at: string }>;

      if (rows.length > 0) {
        logger.debug({ fetchedAt: rows[0].fetched_at }, "Category cache hit");
        return JSON.parse(rows[0].tree_json) as OzonCategoryNode[];
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Category cache read failed");
    }
  }

  // Fetch from Ozon API
  logger.info("Category cache miss — fetching from Ozon API");
  const tree = await ozonClient.getCategoryTree();

  // Store in cache
  if (db && tree.length > 0) {
    try {
      await db.run(
        "INSERT OR REPLACE INTO category_cache (id, tree_json, fetched_at, ttl_hours) VALUES (1, ?, datetime('now'), ?)",
        [JSON.stringify(tree), ttlHours]
      );
      logger.info({ rootCategories: tree.length }, "Category cache stored");
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Category cache write failed");
    }
  }

  return tree;
}

/**
 * Invalidate the cache — call after major category changes.
 */
export async function invalidateCategoryCache(): Promise<void> {
  const db = await getDb();
  if (db) {
    await db.run("DELETE FROM category_cache WHERE id = 1");
    logger.info("Category cache invalidated");
  }
}

/**
 * Get cache info for diagnostics.
 */
export async function getCategoryCacheInfo(): Promise<CachedTree | null> {
  const db = await getDb();
  if (!db) return null;

  const rows = await db.all(
    "SELECT tree_json, fetched_at, ttl_hours FROM category_cache WHERE id = 1"
  ) as Array<{ tree_json: string; fetched_at: string; ttl_hours: number }>;

  if (rows.length === 0) return null;

  return {
    tree: JSON.parse(rows[0].tree_json),
    fetchedAt: rows[0].fetched_at,
    ttlHours: rows[0].ttl_hours,
  };
}
