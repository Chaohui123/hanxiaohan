// ============================================================
// Ozon Order Sync v2 — enriched order sync with 1688 matching
// Features: Redis distributed lock, profit check, multi-store
// ============================================================

import type { DbAdapter } from "../db/connection.js";
import type { OzonClient } from "@onzo/ozon-api-wrapper";
import type { OzonPosting, OzonOrderProduct, OzonOrder, SyncSummary } from "@onzo/shared-types";
import { OzonOrderClient } from "@onzo/ozon-order";
import { logger } from "@onzo/logger";
import { acquireLock, releaseLock } from "./redis-lock.js";
import { getActiveStoreConfigs } from "../db/models.js";
import { decrypt, isEncrypted } from "./crypto.js";

// ---- Types ----

interface StoreSyncResult {
  storeId: string;
  newOrders: number;
  flaggedOrders: number;
  skippedOrders: number;
  errors: string[];
}

// ---- Main Service ----

export class OzonOrderSyncService {
  constructor(private db: DbAdapter | null) {}

  /** Sync all active stores. Each store is independently locked and synced. */
  async syncAllStores(): Promise<SyncSummary> {
    const errors: string[] = [];
    let totalOrders = 0;
    let newOrders = 0;
    let flaggedOrders = 0;
    let skippedOrders = 0;

    const stores = await getActiveStoreConfigs();
    if (stores.length === 0) {
      logger.info("OzonOrderSync: No active stores configured");
      return { storesScanned: 0, totalOrders: 0, newOrders: 0, flaggedOrders: 0, skippedOrders: 0, errors: [] };
    }

    logger.info({ storeCount: stores.length }, "OzonOrderSync: Starting sync for all stores");

    for (const store of stores) {
      const storeId = store.storeId;

      // Distributed lock — skip if another instance is syncing this store
      const lockToken = await acquireLock(storeId, 120);
      if (!lockToken) {
        logger.info({ storeId }, "OzonOrderSync: Lock held by another instance, skipping");
        skippedOrders++;
        continue;
      }

      try {
        const result = await this.syncStore(storeId, store.clientId, store.apiKey);
        totalOrders += result.newOrders + result.skippedOrders;
        newOrders += result.newOrders;
        flaggedOrders += result.flaggedOrders;
        errors.push(...result.errors.map((e) => `[${storeId}] ${e}`));
      } catch (err) {
        errors.push(`[${storeId}] ${(err as Error).message}`);
      } finally {
        await releaseLock(storeId, lockToken);
      }
    }

    logger.info({ storesScanned: stores.length, totalOrders, newOrders, flaggedOrders, errors: errors.length },
      "OzonOrderSync: All stores synced");

    return { storesScanned: stores.length, totalOrders, newOrders, flaggedOrders, skippedOrders, errors };
  }

  /** Sync a single store by storeId. Fetches FBS + FBO, enriches, persists. */
  async syncStore(storeId: string, clientId: string, apiKey: string): Promise<StoreSyncResult> {
    const errors: string[] = [];
    let newOrders = 0;
    let flaggedOrders = 0;
    let skippedOrders = 0;

    const resolvedKey = isEncrypted(apiKey) ? decrypt(apiKey) : apiKey;

    // Create per-store OzonClient
    const { AuthManager } = await import("@onzo/ozon-api-wrapper");
    const auth = new AuthManager({ clients: [{ clientId, apiKey: resolvedKey, storeId }] });
    const ozonClient = new (await import("@onzo/ozon-api-wrapper")).OzonClient({ auth });
    const orderClient = new OzonOrderClient(ozonClient);

    const statuses = ["awaiting_packaging", "awaiting_deliver"];

    for (const status of statuses) {
      // FBS
      try {
        const fbsPostings = await orderClient.listPostings({ status: status as never, limit: 100 });
        for (const p of fbsPostings) {
          const result = await this.processPosting(p, storeId);
          if (result === "new") newOrders++;
          else if (result === "flagged") { newOrders++; flaggedOrders++; }
          else skippedOrders++;
        }
      } catch (err) {
        errors.push(`FBS/${status}: ${(err as Error).message}`);
      }

      // FBO
      try {
        const fboPostings = await orderClient.listFboPostings({ status: status as never, limit: 100 });
        for (const p of fboPostings) {
          const result = await this.processPosting(p, storeId);
          if (result === "new") newOrders++;
          else if (result === "flagged") { newOrders++; flaggedOrders++; }
          else skippedOrders++;
        }
      } catch (err) {
        errors.push(`FBO/${status}: ${(err as Error).message}`);
      }
    }

    return { storeId, newOrders, flaggedOrders, skippedOrders, errors };
  }

  /**
   * Process a single posting: check idempotency, enrich with 1688 source,
   * calculate profit, and upsert into ozon_orders.
   */
  private async processPosting(posting: OzonPosting, storeId: string): Promise<"new" | "flagged" | "skip"> {
    if (!this.db) return "skip";

    // Idempotency check
    const existing = await this.db.all<{ status: string }>(
      "SELECT status FROM ozon_orders WHERE store_id = ? AND posting_number = ?",
      [storeId, posting.postingNumber]
    );
    if (existing.length > 0 && existing[0].status === posting.status) return "skip";

    // Enrich products with 1688 source matching
    const enrichedProducts: OzonOrderProduct[] = [];
    let totalCostCny = 0;
    let hasSource = true;
    let allProfitOk = true;

    for (const product of posting.products) {
      const enriched = await this.enrichProduct(product, storeId);
      enrichedProducts.push(enriched);
      if (!enriched.source1688Url) hasSource = false;
      if (enriched.costCny) totalCostCny += enriched.costCny * enriched.quantity;
      if ((enriched.profitMargin ?? 0) < 10) allProfitOk = false;
    }

    // Calculate overall margin
    const totalPriceRub = posting.price;
    const totalProfitRub = totalPriceRub - totalCostCny * await this.getExchangeRate();
    const marginPercent = totalPriceRub > 0 ? Math.round((totalProfitRub / totalPriceRub) * 1000) / 10 : 0;

    const needsReview = !hasSource || !allProfitOk;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // Upsert
    await this.db.run(
      `INSERT INTO ozon_orders (id, store_id, posting_number, order_id, order_number, status,
        created_at_ozon, shipment_deadline, buyer_name, buyer_phone, products_json,
        total_price_rub, total_cost_cny, total_profit_rub, margin_percent,
        has_1688_source, profit_ok, needs_review, tracking_number, synced_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(store_id, posting_number) DO UPDATE SET
        status = EXCLUDED.status, products_json = EXCLUDED.products_json,
        total_price_rub = EXCLUDED.total_price_rub, total_cost_cny = EXCLUDED.total_cost_cny,
        total_profit_rub = EXCLUDED.total_profit_rub, margin_percent = EXCLUDED.margin_percent,
        has_1688_source = EXCLUDED.has_1688_source, profit_ok = EXCLUDED.profit_ok,
        needs_review = EXCLUDED.needs_review, tracking_number = EXCLUDED.tracking_number,
        updated_at = EXCLUDED.updated_at`,
      [
        id, storeId, posting.postingNumber, posting.orderId, posting.orderNumber, posting.status,
        posting.createdAt, posting.shipmentDate ?? null, posting.buyerName, posting.buyerPhone,
        JSON.stringify(enrichedProducts),
        totalPriceRub, Math.round(totalCostCny * 100) / 100, Math.round(totalProfitRub),
        marginPercent,
        hasSource ? 1 : 0, allProfitOk ? 1 : 0, needsReview ? 1 : 0,
        posting.trackingNumber ?? null, now, now,
      ]
    );

    logger.info({ storeId, postingNumber: posting.postingNumber, needsReview, marginPercent },
      "OzonOrderSync: Order processed");

    return needsReview ? "flagged" : "new";
  }

  /** Enrich a single product with 1688 source URL and cost estimate. */
  private async enrichProduct(
    product: OzonPosting["products"][0],
    _storeId: string
  ): Promise<OzonOrderProduct> {
    const result: OzonOrderProduct = {
      sku: product.sku,
      name: product.name,
      quantity: product.quantity,
      price: product.price,
      offerId: product.offerId,
    };

    if (!this.db) return result;

    // Match 1688 source via listing_records
    try {
      const listingRows = await this.db.all<{ source_url: string; result_json: string }>(
        `SELECT lr.source_url, lr.result_json
         FROM listing_records lr
         WHERE lr.ozon_product_id IN (
           SELECT pp.product_id FROM product_performance pp WHERE pp.sku = ? LIMIT 1
         ) LIMIT 1`,
        [product.sku]
      );

      if (listingRows.length > 0 && listingRows[0].source_url) {
        result.source1688Url = listingRows[0].source_url;
      }
    } catch { /* listing_records may not exist in SQLite fallback */ }

    // Estimate cost from price_history
    if (result.source1688Url) {
      try {
        const priceRows = await this.db.all<{ price_rub: number }>(
          "SELECT price_rub FROM price_history WHERE product_sku = ? ORDER BY captured_at DESC LIMIT 1",
          [String(product.sku)]
        );
        if (priceRows.length > 0) {
          const exRate = await this.getExchangeRate();
          result.costCny = Math.round((priceRows[0].price_rub / exRate) * 100) / 100;
          if (result.costCny > 0 && result.price > 0) {
            result.profitMargin = Math.round(((result.price - result.costCny * exRate) / result.price) * 1000) / 10;
          }
        }
      } catch { /* price_history may not exist */ }
    }

    return result;
  }

  private async getExchangeRate(): Promise<number> {
    try {
      const { getExchangeRate } = await import("./exchange-rate.js");
      const result = await getExchangeRate();
      return result.rate;
    } catch {
      return 11.5; // fallback RUB/CNY rate
    }
  }
}
