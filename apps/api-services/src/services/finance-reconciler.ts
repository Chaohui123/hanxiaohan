// ============================================================
// Finance Reconciler — Ozon financial report reconciliation
// Compares local order data with Ozon actual settlement amounts
// ============================================================

import { getDb } from "../db/connection.js";
import { logger } from "@onzo/logger";
import type { OzonClient } from "@onzo/ozon-api-wrapper";

export interface ReconciliationResult {
  totalOrders: number;
  matched: number;
  discrepancies: Array<{
    orderId: string;
    localPayout: number;
    ozonPayout: number;
    difference: number;
    reason?: string;
  }>;
  missingLocal: number;
  missingOzon: number;
}

interface OzonFinanceReport {
  report_id: string;
  begin_date: string;
  end_date: string;
  generated_at: string;
  rows?: Array<{
    posting_number: string;
    order_id: string;
    operation_type: string;
    amount: number;
    commission: number;
    payout: number;
    services_amount: number;
  }>;
}

/**
 * Reconcile local order financials against Ozon's actual settlement data.
 * @param ozonClient Authenticated OzonClient
 * @param dateFrom Start date (YYYY-MM-DD)
 * @param dateTo End date (YYYY-MM-DD)
 */
export async function reconcileFinance(
  ozonClient: OzonClient,
  dateFrom: string,
  dateTo: string
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    totalOrders: 0,
    matched: 0,
    discrepancies: [],
    missingLocal: 0,
    missingOzon: 0,
  };

  const db = await getDb().catch(() => null);
  if (!db) {
    logger.error("Finance reconcile: DB unavailable");
    return result;
  }

  // 1. Fetch Ozon finance reports for the date range
  const ozonRows = new Map<string, { payout: number; commission: number }>();
  try {
    const reportList = await (ozonClient as { request: (m: string, p: string, b: unknown) => Promise<{ result: { rows?: Array<{ report_id: string }> } }> }).request(
      "POST",
      "/v3/finance/reports/list",
      {
        date: { from: dateFrom, to: dateTo },
      }
    );

    const reportIds = reportList.result?.rows?.map((r) => r.report_id) || [];
    logger.info({ reportCount: reportIds.length, dateFrom, dateTo }, "Finance reports fetched");

    for (const reportId of reportIds.slice(0, 10)) {
      try {
        const detail = await (ozonClient as { request: (m: string, p: string, b: unknown) => Promise<{ result: OzonFinanceReport }> }).request(
          "POST",
          `/v3/finance/reports/${reportId}/details`,
          {}
        );
        for (const row of detail.result?.rows || []) {
          if (row.posting_number) {
            ozonRows.set(row.posting_number, { payout: row.payout, commission: row.commission });
          }
        }
      } catch (err) {
        logger.warn({ reportId, err: (err as Error).message }, "Failed to fetch report detail");
      }
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, "Failed to fetch Ozon finance reports");
    return result;
  }

  // 2. Fetch local orders for the same period
  const localOrders = await db.all(
    `SELECT posting_number, order_id, payout_rub, commission_rub
     FROM local_orders
     WHERE created_at >= ? AND created_at <= ? AND status IN ('delivered', 'cancelled')
     ORDER BY posting_number`,
    [dateFrom, dateTo]
  ) as Array<{ posting_number: string; order_id: number; payout_rub: number; commission_rub: number }>;

  result.totalOrders = localOrders.length + ozonRows.size;

  // 3. Compare: local vs Ozon
  const localSet = new Set(localOrders.map((o) => o.posting_number));

  for (const local of localOrders) {
    const ozon = ozonRows.get(local.posting_number);
    if (!ozon) {
      result.missingOzon++;
      continue;
    }

    const diff = Math.abs(local.payout_rub - ozon.payout);
    if (diff > 0.01) {
      result.discrepancies.push({
        orderId: String(local.order_id),
        localPayout: local.payout_rub,
        ozonPayout: ozon.payout,
        difference: Math.round(diff * 100) / 100,
        reason: diff > 10 ? "Significant difference — investigate" : "Minor rounding",
      });
    } else {
      result.matched++;
    }
  }

  // Ozon orders not found locally
  for (const postingNumber of ozonRows.keys()) {
    if (!localSet.has(postingNumber)) {
      result.missingLocal++;
    }
  }

  logger.info({
    total: result.totalOrders,
    matched: result.matched,
    discrepancies: result.discrepancies.length,
    missingLocal: result.missingLocal,
    missingOzon: result.missingOzon,
  }, "Finance reconciliation complete");

  return result;
}
