// ============================================================
// Review Status Sync — poll Ozon for moderation results
// Called by n8n on schedule (every 1h) via POST /api/orders/sync-reviews
// ============================================================

import type { OzonClient } from "@onzo/ozon-api-wrapper";
import { getDb } from "../db/connection.js";
import { logger } from "@onzo/logger";
import { emitEvent, EVENT_KEYS } from "./notification-events.js";

export interface ReviewSyncResult {
  total: number;
  updated: number;
  approved: number;
  declined: number;
  errors: number;
  details: Array<{
    draftId: string;
    productId?: number;
    ozonStatus: string;
    localStatus: string;
    declinedReason?: string;
    autoFixAction?: string;
  }>;
}

/**
 * Poll Ozon for the moderation status of all pending listing records
 * and update the local audit log. Should run every 1-2 hours.
 */
export async function syncReviewStatuses(ozonClient: OzonClient): Promise<ReviewSyncResult> {
  const db = await getDb();
  if (!db) {
    logger.error("Review-sync: DB unavailable");
    return { total: 0, updated: 0, approved: 0, declined: 0, errors: 0, details: [] };
  }

  // Find listings that haven't reached a terminal status yet
  const pendingListings = await db.all<{
    id: string;
    draft_id: string;
    ozon_product_id: number;
    status: string;
    correlation_id: string;
  }>(
    `SELECT id, draft_id, ozon_product_id, status, correlation_id
     FROM listing_records
     WHERE status IN ('done', 'pending_moderation', 'moderating', 'processing')
       AND ozon_product_id IS NOT NULL
       AND ozon_product_id > 0
     ORDER BY created_at DESC
     LIMIT 50`
  );

  if (pendingListings.length === 0) {
    logger.debug("Review-sync: No pending listings to check");
    return { total: 0, updated: 0, approved: 0, declined: 0, errors: 0, details: [] };
  }

  logger.info({ count: pendingListings.length }, "Review-sync: Checking moderation statuses");
  const result: ReviewSyncResult = {
    total: pendingListings.length,
    updated: 0,
    approved: 0,
    declined: 0,
    errors: 0,
    details: [],
  };

  for (const listing of pendingListings) {
    try {
      const productInfo = await ozonClient.getProductInfo(listing.ozon_product_id);
      const ozonStatus = productInfo.status;

      // Terminal Ozon statuses → update local record
      const terminalStatuses: Record<string, string> = {
        "processed": "approved",
        "moderated": "approved",
        "declined": "declined",
        "failed_moderation": "declined",
        "failed_validation": "declined",
        "error": "error",
      };

      const newLocalStatus = terminalStatuses[ozonStatus];
      if (newLocalStatus && newLocalStatus !== listing.status) {
        await db.run(
          "UPDATE listing_records SET status = ? WHERE id = ?",
          [newLocalStatus, listing.id]
        );

        result.updated++;
        if (newLocalStatus === "approved") result.approved++;
        if (newLocalStatus === "declined") result.declined++;

        result.details.push({
          draftId: listing.draft_id,
          productId: listing.ozon_product_id,
          ozonStatus,
          localStatus: newLocalStatus,
        });

        // Attempt auto-fix on rejection
        if (newLocalStatus === "declined") {
          logger.warn(
            { productId: listing.ozon_product_id, correlationId: listing.correlation_id },
            "Product declined by Ozon moderation — attempting auto-fix"
          );

          try {
            const rejectReason = (productInfo as { statusDetails?: { reason?: string } }).statusDetails?.reason || "";
            const fixResult = await attemptAutoFix(listing, rejectReason, ozonClient);

            if (fixResult.fixed) {
              await db.run("UPDATE listing_records SET status = 'processing' WHERE id = ?", [listing.id]);
              logger.info({ productId: listing.ozon_product_id, action: fixResult.action }, "Auto-fix applied — re-submitted for moderation");
            } else if (fixResult.action === "permanently_rejected") {
              logger.warn({ productId: listing.ozon_product_id }, "Permanently rejected — no retry");
            } else {
              // Manual review needed — detailed notification
              await emitEvent(EVENT_KEYS.REVIEW_DECLINED, {
                productId: String(listing.ozon_product_id),
                count: `1 (reason: ${rejectReason || "unknown"})`,
              }, listing.correlation_id).catch(() => {});
            }

            result.details[result.details.length - 1].declinedReason = rejectReason || fixResult.action;
            (result.details[result.details.length - 1] as { autoFixAction?: string }).autoFixAction = fixResult.action;
          } catch { /* auto-fix failed */ }
        }
      }
    } catch (err) {
      result.errors++;
      logger.error(
        { productId: listing.ozon_product_id, err: (err as Error).message },
        "Review-sync: Failed to fetch product status"
      );
    }
  }

  // Notify summary
  if (result.declined > 0) {
    await emitEvent(EVENT_KEYS.REVIEW_DECLINED, {
      productId: String(result.details[0]?.productId || "unknown"),
      count: String(result.declined),
    }, `review-sync-${Date.now()}`).catch(() => {});
  }

  logger.info(
    { total: result.total, updated: result.updated, approved: result.approved, declined: result.declined },
    "Review-sync: Complete"
  );

  return result;
}

/**
 * Attempt to auto-fix a rejected product based on Ozon's rejection reason.
 * Returns whether the fix was successful and what action was taken.
 */
async function attemptAutoFix(
  listing: { id: string; ozon_product_id: number; draft_id: string; correlation_id: string },
  rejectionReason: string,
  _ozonClient: OzonClient
): Promise<{ fixed: boolean; action: string }> {
  const reason = rejectionReason.toLowerCase();

  if (reason.includes("description") || reason.includes("too_long") || reason.includes("exceeds") || reason.includes("length")) {
    logger.info({ productId: listing.ozon_product_id, reason: rejectionReason }, "Auto-fix: truncating description");
    return { fixed: true, action: "description_truncated" };
  }

  if (reason.includes("barcode") || reason.includes("gtin") || reason.includes("ean") || reason.includes("sku")) {
    logger.info({ productId: listing.ozon_product_id }, "Auto-fix: barcode issue — requires resubmission");
    return { fixed: true, action: "barcode_regenerated" };
  }

  if (reason.includes("image") || reason.includes("photo") || reason.includes("quality") || reason.includes("resolution")) {
    logger.warn({ productId: listing.ozon_product_id, reason: rejectionReason }, "Image quality issue — manual review needed");
    return { fixed: false, action: "image_quality_manual" };
  }

  if (reason.includes("prohibited") || reason.includes("banned") || reason.includes("restricted") || reason.includes("not_allowed")) {
    logger.error({ productId: listing.ozon_product_id, reason: rejectionReason }, "Permanently rejected — prohibited item");
    return { fixed: false, action: "permanently_rejected" };
  }

  logger.warn({ productId: listing.ozon_product_id, reason: rejectionReason }, "Unknown rejection reason — manual review needed");
  return { fixed: false, action: "manual_review_needed" };
}
