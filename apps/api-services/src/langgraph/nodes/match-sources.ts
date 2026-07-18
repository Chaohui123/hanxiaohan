import { ProcurementState } from "../state.js";
// ============================================================
// Node 2: Source Matching — match order products to 1688 SKU mapping
// ============================================================

import type { SourceMatch } from "../state.js";
type StateType = typeof ProcurementState.State;
import { getDb } from "../../db/connection.js";
import { logger } from "@onzo/logger";

export async function matchSourcesNode(
  state: StateType,
): Promise<Partial<StateType>> {
  const order = state.ozonOrder;
  if (!order) {
    return { matchError: "No order to match", sourceMatches: [] };
  }

  logger.info({ postingNumber: order.postingNumber, productCount: order.products.length },
    "LangGraph: matching 1688 sources");

  try {
    const db = await getDb().catch(() => null);
    if (!db) {
      return { matchError: "Database unavailable", sourceMatches: [] };
    }

    const matches: SourceMatch[] = [];

    for (const product of order.products) {
      const rows = await db.all<{
        offer_1688_id: string; source_1688_url: string; purchase_price_cny: number;
        weight_kg: number; freight_address: string; supplier_name: string;
      }>(
        `SELECT offer_1688_id, source_1688_url, purchase_price_cny,
                weight_kg, freight_address, supplier_name
         FROM sku_1688_mapping
         WHERE ozon_sku = ? AND store_id = ?
         LIMIT 1`,
        [product.sku, state.storeId || "store_1"],
      );

      if (rows.length > 0) {
        const r = rows[0]!;
        matches.push({
          sku: product.sku,
          offerId: r.offer_1688_id || null,
          source1688Url: r.source_1688_url,
          purchasePriceCny: r.purchase_price_cny,
          weightKg: r.weight_kg || 0.3,
          freightAddress: r.freight_address || process.env.FREIGHT_ADDRESS || "",
          supplierName: r.supplier_name || "",
        });
      }
    }

    return {
      sourceMatches: matches,
      matchError: matches.length === 0
        ? `No 1688 sources matched for ${order.products.length} products`
        : "",
    };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ err: msg }, "LangGraph: source matching failed");
    return { matchError: msg, sourceMatches: [] };
  }
}
