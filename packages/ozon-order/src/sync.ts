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
  errors: string[];
}

/**
 * Sync orders from Ozon (FBS + FBO) with pagination.
 * Calls the order route's business logic.
 */
export async function syncOrders(
  ozonClient: OzonClient,
  status?: string,
  since?: string,
  until?: string
): Promise<SyncResult> {
  const client = new OzonOrderClient(ozonClient);
  const errors: string[] = [];
  let fbsCount = 0;
  let fboCount = 0;

  try {
    const fbsOrders = await client.listPostings({ status: status as OzonPosting["status"] | undefined, since, until, limit: 100 });
    fbsCount = fbsOrders.length;
  } catch (err) {
    errors.push(`FBS sync failed: ${(err as Error).message}`);
  }

  try {
    const fboOrders = await client.listFboPostings({ status: status as OzonPosting["status"] | undefined, since, until, limit: 100 });
    fboCount = fboOrders.length;
  } catch (err) {
    errors.push(`FBO sync failed: ${(err as Error).message}`);
  }

  return {
    fbsCount,
    fboCount,
    total: fbsCount + fboCount,
    upserted: 0, // set by caller
    errors,
  };
}
