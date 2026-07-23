// ============================================================
// Import Status Sync — backfill real ozon_product_id.
// /v3/product/import is async: createDraft returns a task_id, but the
// REAL product_id only exists after the task reaches "imported".
// listing_records.ozon_product_id and sku_1688_mapping.ozon_sku initially
// hold the task_id — this job replaces it with the real product_id,
// otherwise order→1688 purchase matching fails (sku mismatch).
// ============================================================

import { getDb } from "../db/connection.js";
import { logger } from "@onzo/logger";
import type { OzonClient } from "@onzo/ozon-api-wrapper";
import { nowDb } from "../utils/time.js";

interface ListingRow extends Record<string, unknown> {
  id: string;
  draft_id: string;
  ozon_product_id: number;
  status: string;
}

export interface ImportSyncResult {
  checked: number;
  backfilled: number;
  failed: number;
  stillProcessing: number;
}

export async function syncImportStatuses(ozonClient: OzonClient, limit = 50): Promise<ImportSyncResult> {
  const db = await getDb();
  if (!db) {
    logger.error("Import-status-sync: DB unavailable");
    return { checked: 0, backfilled: 0, failed: 0, stillProcessing: 0 };
  }

  // Task ids are stored in ozon_product_id until import completes.
  // Only check records not yet in a terminal state.
  const rows = (await db.all(
    `SELECT id, draft_id, ozon_product_id, status FROM listing_records
     WHERE status IN ('processing', 'moderating', 'pending_moderation', 'draft')
       AND ozon_product_id IS NOT NULL AND ozon_product_id > 0
     ORDER BY created_at ASC LIMIT ?`,
    [limit]
  )) as ListingRow[];

  const result: ImportSyncResult = { checked: rows.length, backfilled: 0, failed: 0, stillProcessing: 0 };

  for (const row of rows) {
    const taskId = Number(row.ozon_product_id);
    if (!taskId) continue;

    try {
      const info = await ozonClient.getImportStatus(taskId);
      if (!info) {
        result.stillProcessing++;
        continue;
      }

      if (info.status === "imported" && info.productId > 0) {
        // Backfill real product_id everywhere the task_id was used
        await db.run(
          "UPDATE listing_records SET ozon_product_id = ?, status = 'done', result_json = ? WHERE id = ?",
          [info.productId, JSON.stringify({ offerId: info.offerId, importedAt: nowDb() }), row.id]
        );
        const mapRes = await db.run(
          "UPDATE sku_1688_mapping SET ozon_sku = ?, updated_at = ? WHERE ozon_sku = ?",
          [info.productId, nowDb(), taskId]
        );
        result.backfilled++;
        logger.info({
          taskId, realProductId: info.productId, listingId: row.id, skuMappingUpdated: mapRes.changes,
        }, "Import-status-sync: backfilled real product_id");
      } else if (info.status === "failed") {
        const errMsg = info.errors.map((e) => e.description).join("; ").slice(0, 500);
        await db.run(
          "UPDATE listing_records SET status = 'failed', result_json = ? WHERE id = ?",
          [JSON.stringify({ errors: info.errors }), row.id]
        );
        result.failed++;
        logger.warn({ taskId, listingId: row.id, errMsg }, "Import-status-sync: import task failed");
      } else {
        result.stillProcessing++;
      }
    } catch (err) {
      logger.warn({ taskId, err: (err as Error).message }, "Import-status-sync: status check failed");
      result.stillProcessing++;
    }
  }

  if (result.checked > 0) {
    logger.info({ ...result }, "Import-status-sync: cycle complete");
  }
  return result;
}
