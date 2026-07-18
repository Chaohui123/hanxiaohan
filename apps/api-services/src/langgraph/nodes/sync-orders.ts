// ============================================================
// Node 1: Ozon Order Sync — fetch order by posting number
// ============================================================

import { ProcurementState } from "../state.js";
type StateType = typeof ProcurementState.State;
import { getDb } from "../../db/connection.js";
import { logger } from "@onzo/logger";

export async function syncOrderNode(
  state: StateType,
): Promise<Partial<StateType>> {
  const postingNumber = state.postingNumber;
  logger.info({ postingNumber }, "LangGraph: syncing Ozon order");

  try {
    const db = await getDb().catch(() => null);
    if (!db) {
      return { orderSyncError: "Database unavailable", ozonOrder: null };
    }

    // Query from local_orders (synced by background order-sync jobs)
    const rows = await db.all<{
      posting_number: string; order_id: number; status: string;
      total_price_rub: number; raw_json: string; created_at: string;
    }>(
      `SELECT posting_number, order_id, status, total_price_rub, raw_json, created_at
       FROM local_orders WHERE posting_number = ? LIMIT 1`,
      [postingNumber],
    );

    if (rows.length === 0) {
      // Also try ozon_orders v2 table
      const v2Rows = await db.all<{
        posting_number: string; order_id: number; status: string;
        total_price_rub: number; products_json: string; created_at_ozon: string;
      }>(
        `SELECT posting_number, order_id, status, total_price_rub, products_json, created_at_ozon
         FROM ozon_orders WHERE posting_number = ? LIMIT 1`,
        [postingNumber],
      );

      if (v2Rows.length === 0) {
        return { orderSyncError: `Order not found: ${postingNumber}`, ozonOrder: null };
      }

      const r = v2Rows[0]!;
      const products = JSON.parse(r.products_json || "[]") as Array<{
        sku: number; name: string; quantity: number; price: number;
      }>;

      return {
        ozonOrder: {
          postingNumber: r.posting_number,
          orderId: r.order_id,
          status: r.status,
          products,
          totalPriceRub: r.total_price_rub,
          createdAt: r.created_at_ozon,
        },
        orderSyncError: "",
      };
    }

    const r = rows[0]!;
    let products: Array<{ sku: number; name: string; quantity: number; price: number }> = [];
    try {
      const raw = JSON.parse(r.raw_json || "{}");
      products = (raw.products || []).map((p: Record<string, unknown>) => ({
        sku: (p.sku as number) || 0,
        name: (p.name as string) || "",
        quantity: (p.quantity as number) || 1,
        price: (p.price as number) || 0,
      }));
    } catch { /* raw_json parse failed — use empty products */ }

    return {
      ozonOrder: {
        postingNumber: r.posting_number,
        orderId: r.order_id,
        status: r.status,
        products,
        totalPriceRub: r.total_price_rub,
        createdAt: r.created_at,
      },
      orderSyncError: "",
    };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ postingNumber, err: msg }, "LangGraph: order sync failed");
    return { orderSyncError: msg, ozonOrder: null };
  }
}
