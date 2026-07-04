// ============================================================
// Order Sync — paginated batch sync with idempotency
// ============================================================

import type { OzonClient } from "@onzo/ozon-api-wrapper";
import type { OzonPosting } from "@onzo/shared-types";
import { OzonOrderClient } from "./client.js";

export interface SyncResult {
  fbsCount: number;
  fboCount: number;
  total: number;
  upserted: number;
  skipped: number;
  errors: string[];
}

export type ProcessPostingFn = (posting: OzonPosting, ctx: { db?: { all: (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>> }; idempotencyKey: string; storeId: string }) => Promise<void>;

/**
 * Sync orders from Ozon (FBS + FBO) with pagination and idempotency checks.
 * - `processPosting` will be called for each new posting (not present in `local_orders` when `db` provided).
 */
export async function syncOrders(
  ozonClient: OzonClient,
  options?: {
    status?: string
    since?: string
    until?: string
    client?: OzonOrderClient
    storeId?: string
    db?: { all: (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>> }
    processPosting?: ProcessPostingFn
    pageSize?: number
  }
): Promise<SyncResult> {
  const client = options?.client ?? new OzonOrderClient(ozonClient);
  const errors: string[] = [];
  let fbsCount = 0;
  let fboCount = 0;

  const pageSize = options?.pageSize ?? 100;
  let localProcessedCount = 0;
  let skippedCount = 0;

  // Helper to iterate paged postings
  async function iterateList(listFn: (filter?: Record<string, unknown>) => Promise<OzonPosting[]>) {
    let offset = 0
    let localCount = 0
    while (true) {
      const postings = await listFn({ status: options?.status as OzonPosting["status"] | undefined, since: options?.since, until: options?.until, limit: pageSize, offset })
      if (!postings || postings.length === 0) break

      for (const p of postings) {
        const idempotencyKey = `${options?.storeId ?? "store_1"}:${p.orderId}`;
        if (options?.db) {
          const storeId = options.storeId ?? "store_1";
          const rows = await options.db.all(`SELECT COUNT(*) as cnt FROM local_orders WHERE store_id = ? AND order_id = ?`, [storeId, p.orderId]);
          if (rows?.[0]?.cnt && rows[0].cnt > 0) {
            skippedCount++;
            continue;
          }
        }

        if (options?.processPosting) {
          await options.processPosting(p, { db: options.db, idempotencyKey, storeId: options?.storeId ?? "store_1" })
        }

        localCount++
      }

      if (postings.length < pageSize) break
      offset += postings.length
    }
    localProcessedCount += localCount;
    return localCount
  }

  try {
    fbsCount = await iterateList((filter) => client.listPostings(filter))
  } catch (err) {
    errors.push(`FBS sync failed: ${(err as Error).message}`)
  }

  try {
    fboCount = await iterateList((filter) => client.listFboPostings(filter))
  } catch (err) {
    errors.push(`FBO sync failed: ${(err as Error).message}`)
  }

  return {
    fbsCount,
    fboCount,
    total: fbsCount + fboCount,
    upserted: localProcessedCount,
    skipped: skippedCount,
    errors,
  }
}
