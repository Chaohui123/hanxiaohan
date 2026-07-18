// ============================================================
// Node 5: Create 1688 Purchase Order (MANUAL_PAY_MODE)
// Creates a local purchase_1688 record for manual payment
// ============================================================

import { ProcurementState } from "../state.js";
type StateType = typeof ProcurementState.State;
import { getDb, serializedWrite } from "../../db/connection.js";
import { logger } from "@onzo/logger";
import { randomUUID } from "node:crypto";

export async function createPurchaseNode(
  state: StateType,
): Promise<Partial<StateType>> {
  const order = state.ozonOrder;
  const matches = state.sourceMatches;
  const profit = state.profit;

  if (!order || matches.length === 0) {
    return { purchaseError: "No order or sources to create purchase", purchaseId: "" };
  }

  if (profit && !profit.isProfitable) {
    logger.warn({ postingNumber: order.postingNumber, margin: profit.marginPercent },
      "LangGraph: skipping purchase — order not profitable");
    return { purchaseError: "Order not profitable — skipped", purchaseId: "" };
  }

  const enabled = process.env.MANUAL_PAY_MODE === "true";
  if (!enabled) {
    return { purchaseError: "MANUAL_PAY_MODE not enabled", purchaseId: "" };
  }

  logger.info({ postingNumber: order.postingNumber }, "LangGraph: creating purchase order");

  try {
    const db = await getDb().catch(() => null);
    if (!db) {
      return { purchaseError: "Database unavailable", purchaseId: "" };
    }

    const purchaseId = `po_${randomUUID().slice(0, 12)}`;
    const totalCny = matches.reduce((sum: number, m: { purchasePriceCny: number }) => sum + m.purchasePriceCny, 0);
    const skuList = matches.map((m) => ({
      sku: m.sku,
      quantity: order.products.find((p: { sku: number; quantity: number }) => p.sku === m.sku)?.quantity || 1,
      unitPriceCny: m.purchasePriceCny,
    }));
    const freightAddr = (matches[0] as { freightAddress?: string } | undefined)?.freightAddress
      || process.env.FREIGHT_ADDRESS
      || "";

    await serializedWrite(() =>
      db.run(
        `INSERT INTO purchase_1688
         (id, store_id, ozon_posting_number, ozon_order_id, source_1688_url,
          offer_id, sku_list_json, total_amount_cny, payment_status,
          pay_channel, logistics_status, freight_address, risk_check_json,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_payment',
          'manual_pay', 'idle', ?, ?, datetime('now'), datetime('now'))`,
        [
          purchaseId,
          state.storeId || "store_1",
          order.postingNumber,
          order.orderId,
          matches[0]?.source1688Url || "",
          matches[0]?.offerId || "",
          JSON.stringify(skuList),
          totalCny,
          freightAddr,
          JSON.stringify({
            manualPayMode: true,
            needsLogin: true,
            source: "langgraph-workflow",
            profitMargin: profit?.marginPercent,
          }),
        ],
      )
    );

    logger.info({ purchaseId, postingNumber: order.postingNumber, totalCny },
      "LangGraph: purchase order created");

    return { purchaseId, purchaseError: "" };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ err: msg }, "LangGraph: purchase creation failed");
    return { purchaseError: msg, purchaseId: "" };
  }
}
