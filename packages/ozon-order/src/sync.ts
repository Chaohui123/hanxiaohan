// ============================================================
// Order Sync — FBO + FBS, incremental, paginated, conflict-safe
// ============================================================

import type { OzonClient } from "@onzo/ozon-api-wrapper";
import type { OzonPosting, OzonOrderStatus } from "@onzo/shared-types";
import { OzonOrderClient } from "./client.js";

export interface SyncResult {
  fbsCount: number;
  fboCount: number;
  total: number;
  upserted: number;
  skipped: number;
  errors: string[];
  lastSyncTimestamp: string;
}

export interface SyncOptions {
  status?: string;
  since?: string;
  until?: string;
  storeId?: string;
  pageSize?: number;
  db?: { all: (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>; run: (sql: string, params?: unknown[]) => Promise<{ changes: number }> };
  processPosting?: (posting: OzonPosting, ctx: { idempotencyKey: string; storeId: string }) => Promise<void>;
  /** Only sync orders newer than this ISO timestamp (incremental sync). */
  sinceTimestamp?: string;
}

export type ProcessPostingFn = NonNullable<SyncOptions["processPosting"]>;

/** Conflict resolution strategy when local and remote statuses differ */
export type ConflictStrategy = "remote_wins" | "local_wins" | "newest_wins";

/** Sync metrics for monitoring */
export interface SyncMetrics {
  lastSyncTimestamp: string | null;
  lastSyncDurationMs: number;
  totalSyncs: number;
  totalUpserted: number;
  totalSkipped: number;
  avgLatencyMs: number;
  successRate: number;
}

let syncMetrics: SyncMetrics = {
  lastSyncTimestamp: null,
  lastSyncDurationMs: 0,
  totalSyncs: 0,
  totalUpserted: 0,
  totalSkipped: 0,
  avgLatencyMs: 0,
  successRate: 1,
};

export function getSyncMetrics(): Readonly<SyncMetrics> {
  return { ...syncMetrics };
}

/**
 * Sync orders from Ozon (FBS + FBO) with incremental pagination.
 * - Incremental: if sinceTimestamp not provided, uses 7 days ago.
 * - Idempotent: skips orders already in local_orders by (store_id, order_id).
 * - Conflict: resolves status conflicts with remote_wins by default.
 */
export async function syncOrders(
  ozonClient: OzonClient,
  options?: SyncOptions
): Promise<SyncResult> {
  const client = options?.client ?? new OzonOrderClient(ozonClient);
  const errors: string[] = [];
  const storeId = options?.storeId ?? "store_1";
  const pageSize = options?.pageSize ?? 50;
  const startTime = Date.now();

  // Incremental: default to 7 days if no since specified
  const since = options?.sinceTimestamp || options?.since || new Date(Date.now() - 7 * 86400000).toISOString();
  const until = options?.until || new Date().toISOString();

  let fbsCount = 0;
  let fboCount = 0;
  let skippedCount = 0;
  let upsertedCount = 0;

  // Paged iterator for Ozon postings
  async function iterateList(
    listFn: (filter: Record<string, unknown>) => Promise<OzonPosting[]>
  ): Promise<number> {
    let offset = 0;
    let localCount = 0;

    while (true) {
      const postings = await listFn({
        status: options?.status,
        since,
        until,
        limit: pageSize,
        offset,
      });

      if (!postings || postings.length === 0) break;

      for (const p of postings) {
        const idempotencyKey = `${storeId}:${p.orderId}`;

        // Idempotency check
        if (options?.db) {
          const rows = await options.db.all(
            "SELECT status FROM local_orders WHERE store_id = ? AND order_id = ?",
            [storeId, p.orderId]
          ) as Array<{ status: string }>;

          if (rows.length > 0) {
            const localStatus = rows[0].status;
            // Conflict: remote status differs from local
            if (localStatus !== p.status) {
              // remote_wins by default
              await options.db.run(
                "UPDATE local_orders SET status = ?, updated_at = NOW() WHERE store_id = ? AND order_id = ?",
                [p.status, storeId, p.orderId]
              );
              upsertedCount++;
            } else {
              skippedCount++;
            }
            continue;
          }
        }

        // New order — delegate to processPosting callback
        if (options?.processPosting) {
          await options.processPosting(p, { idempotencyKey, storeId });
        }

        upsertedCount++;
        localCount++;
      }

      // Pagination break: fewer than pageSize means last page
      if (postings.length < pageSize) break;
      offset += postings.length;
    }

    return localCount;
  }

  // FBS postings
  try {
    fbsCount = await iterateList((filter) => client.listPostings(filter));
  } catch (err) {
    errors.push(`FBS: ${(err as Error).message}`);
  }

  // FBO postings
  try {
    fboCount = await iterateList((filter) => client.listFboPostings(filter));
  } catch (err) {
    errors.push(`FBO: ${(err as Error).message}`);
  }

  // Update metrics
  const duration = Date.now() - startTime;
  syncMetrics.lastSyncTimestamp = new Date().toISOString();
  syncMetrics.lastSyncDurationMs = duration;
  syncMetrics.totalSyncs++;
  syncMetrics.totalUpserted += upsertedCount;
  syncMetrics.totalSkipped += skippedCount;
  syncMetrics.avgLatencyMs = Math.round(
    (syncMetrics.avgLatencyMs * (syncMetrics.totalSyncs - 1) + duration) / syncMetrics.totalSyncs
  );
  syncMetrics.successRate = syncMetrics.totalSyncs > 0
    ? (syncMetrics.totalSyncs - (errors.length > 0 ? 1 : 0)) / syncMetrics.totalSyncs
    : 1;

  return {
    fbsCount,
    fboCount,
    total: fbsCount + fboCount,
    upserted: upsertedCount,
    skipped: skippedCount,
    errors,
    lastSyncTimestamp: syncMetrics.lastSyncTimestamp,
  };
}
