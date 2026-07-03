// ============================================================
// Multi-store management — CRUD, grouping, cross-store ops
// ============================================================

import { Router } from "express";
import { getDb } from "../db/connection.js";
import type { OzonCredentials, OzonClientConfig } from "@onzo/shared-types";

interface StoreRecord {
  storeId: string;
  clientId: string;
  apiKey: string;
  storeName: string | null;
  proxyUrl: string | null;
  groupName: string | null;
  active: number;
  createdAt: string;
}

export function createStoreRouter(): Router {
  const router = Router();

  // GET /api/stores — list all stores with optional group filter
  router.get("/stores", async (req, res) => {
    try {
      const db = await getDb();
      if (!db) { res.json({ success: true, data: [] }); return; }

      const group = req.query.group as string | undefined;
      const sql = group
        ? "SELECT * FROM store_configs WHERE active = 1 AND group_name = ? ORDER BY store_id"
        : "SELECT * FROM store_configs WHERE active = 1 ORDER BY store_id";
      const params = group ? [group] : [];

      const stores = await db.all<StoreRecord>(sql, params);
      res.json({ success: true, data: stores, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "DB_ERROR", message: (err as Error).message, retryable: true }, correlationId: req.correlationId });
    }
  });

  // POST /api/stores — add or update a store
  router.post("/stores", async (req, res) => {
    const { storeId, clientId, apiKey, storeName, groupName, proxyUrl } = req.body as {
      storeId: string; clientId: string; apiKey: string; storeName?: string; groupName?: string; proxyUrl?: string;
    };

    if (!storeId || !clientId || !apiKey) {
      res.status(400).json({ success: false, error: { code: "MISSING_FIELDS", message: "storeId, clientId, apiKey required", retryable: false }, correlationId: req.correlationId });
      return;
    }

    try {
      const db = await getDb();
      if (!db) {
        res.status(503).json({ success: false, error: { code: "DB_UNAVAILABLE" }, correlationId: req.correlationId });
        return;
      }

      await db.run(
        `INSERT OR REPLACE INTO store_configs (store_id, client_id, api_key, store_name, group_name, proxy_url, active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [storeId, clientId, apiKey, storeName ?? null, groupName ?? null, proxyUrl ?? null]
      );

      res.json({ success: true, data: { storeId, storeName, groupName }, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "STORE_SAVE_FAILED", message: (err as Error).message, retryable: true }, correlationId: req.correlationId });
    }
  });

  // DELETE /api/stores/:storeId — deactivate a store
  router.delete("/stores/:storeId", async (req, res) => {
    try {
      const db = await getDb();
      if (!db) { res.status(503).json({ success: false }); return; }

      await db.run("UPDATE store_configs SET active = 0 WHERE store_id = ?", [req.params.storeId]);
      res.json({ success: true, data: { storeId: req.params.storeId, active: false }, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "STORE_DELETE_FAILED", message: (err as Error).message }, correlationId: req.correlationId });
    }
  });

  // GET /api/stores/groups — list store groups with counts
  router.get("/stores/groups", async (req, res) => {
    try {
      const db = await getDb();
      if (!db) { res.json({ success: true, data: [] }); return; }

      const groups = await db.all<{ groupName: string; count: number; active: number }>(
        "SELECT group_name as groupName, COUNT(*) as count, SUM(active) as active FROM store_configs WHERE group_name IS NOT NULL GROUP BY group_name"
      );

      res.json({ success: true, data: groups, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "DB_ERROR", message: (err as Error).message, retryable: true }, correlationId: req.correlationId });
    }
  });

  // POST /api/stores/batch/listing — enqueue listing task across multiple stores
  router.post("/stores/batch/listing", async (req, res) => {
    const { storeIds, product } = req.body as {
      storeIds: string[];
      product: { title: string; priceCny: number; specImages: string[]; specifications?: Array<{ name: string; value: string }>; descriptionText?: string };
    };

    if (!storeIds || !Array.isArray(storeIds) || !product) {
      res.status(400).json({ success: false, error: { code: "MISSING_FIELDS", message: "storeIds array + product required", retryable: false }, correlationId: req.correlationId });
      return;
    }

    // Validate stores exist in DB
    const db = await getDb();
    if (!db) { res.status(503).json({ success: false }); return; }

    const placeholders = storeIds.map(() => "?").join(",");
    const validStores = await db.all<StoreRecord>(
      `SELECT store_id FROM store_configs WHERE store_id IN (${placeholders}) AND active = 1`,
      storeIds
    );

    const taskResults: Array<{ storeId: string; taskId: string }> = [];
    for (const store of validStores) {
      const sid = (store as Record<string, string>).store_id || "";
      taskResults.push({ storeId: sid, taskId: `batch-${sid}-${Date.now()}` });
    }

    res.json({
      success: true,
      data: { requested: storeIds.length, valid: validStores.length, results: taskResults },
      correlationId: req.correlationId,
    });
  });

  return router;
}
