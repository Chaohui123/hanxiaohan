// ============================================================
// SKU-1688 Source Mapping — bind Ozon SKU to 1688 source
// Profit auto-check, RAG-assisted replacement, freight address
// ============================================================

import type { DbAdapter } from "../db/connection.js";
import { logger } from "@onzo/logger";
import { randomUUID } from "node:crypto";
import { cache, TTL } from "@onzo/cache";
import { getExchangeRate } from "./exchange-rate.js";
import { FREIGHT_ADDRESS } from "../config/freight-address.js";
import { calculateProfit } from "./profit-calc.js";

// ---- Types ----

export interface SkuMapping {
  id: string;
  storeId: string;
  ozonOfferId: string;
  ozonSku: number;
  source1688Url: string;
  offer1688Id?: string;
  sku1688Id?: string;
  purchasePriceCny: number;
  freightAddress: string;
  weightKg: number;
  profitThreshold: number;
  ragImageVectorJson?: string;
  lastVerified?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProfitCheckResult {
  passed: boolean;
  ozonSellingPriceRub: number;
  purchaseCostCny: number;
  logisticsCostRub: number;
  platformFeeRub: number;
  netProfitRub: number;
  marginPercent: number;
}

// ---- Service ----

export class SkuMappingService {
  constructor(private db: DbAdapter | null) {}

  /** Bind an Ozon SKU to 1688 source. Called on successful listing. */
  async bind(params: {
    storeId: string;
    ozonOfferId: string;
    ozonSku: number;
    source1688Url: string;
    offer1688Id?: string;
    sku1688Id?: string;
    purchasePriceCny: number;
    weightKg?: number;
    freightAddress?: string;
    supplierName?: string;
    supplierPickupRate?: number;
  }): Promise<SkuMapping> {
    if (!this.db) throw new Error("DB unavailable");

    const id = randomUUID();
    const now = new Date().toISOString();
    const mapping: SkuMapping = {
      id, storeId: params.storeId, ozonOfferId: params.ozonOfferId, ozonSku: params.ozonSku,
      source1688Url: params.source1688Url, offer1688Id: params.offer1688Id, sku1688Id: params.sku1688Id,
      purchasePriceCny: params.purchasePriceCny,
      freightAddress: params.freightAddress || FREIGHT_ADDRESS,
      weightKg: params.weightKg || 0.3, profitThreshold: 0.10,
      lastVerified: now, createdAt: now, updatedAt: now,
    };

    await this.db.run(
      `INSERT INTO sku_1688_mapping (id, store_id, ozon_offer_id, ozon_sku, source_1688_url, offer_1688_id, sku_1688_id,
        purchase_price_cny, freight_address, weight_kg, profit_threshold,
        supplier_name, supplier_pickup_rate,
        last_verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(store_id, ozon_offer_id, ozon_sku) DO UPDATE SET
        source_1688_url = EXCLUDED.source_1688_url,
        offer_1688_id = EXCLUDED.offer_1688_id,
        purchase_price_cny = EXCLUDED.purchase_price_cny,
        freight_address = EXCLUDED.freight_address,
        weight_kg = EXCLUDED.weight_kg,
        supplier_name = COALESCE(EXCLUDED.supplier_name, sku_1688_mapping.supplier_name),
        supplier_pickup_rate = COALESCE(EXCLUDED.supplier_pickup_rate, sku_1688_mapping.supplier_pickup_rate),
        last_verified = EXCLUDED.last_verified,
        updated_at = EXCLUDED.updated_at`,
      [id, mapping.storeId, mapping.ozonOfferId, mapping.ozonSku, mapping.source1688Url,
        mapping.offer1688Id || null, mapping.sku1688Id || null,
        mapping.purchasePriceCny, mapping.freightAddress, mapping.weightKg,
        mapping.profitThreshold,
        params.supplierName || "", params.supplierPickupRate ?? 0,
        mapping.lastVerified, mapping.createdAt, mapping.updatedAt]
    );

    // Cache the mapping
    await cache.cachedSet("sku:mapping", `${params.storeId}:${params.ozonOfferId}:${params.ozonSku}`, mapping, TTL.STORE_CONFIG);
    logger.info({ offerId: params.ozonOfferId, sku: params.ozonSku }, "SKU mapping: bound");
    return mapping;
  }

  /** Lookup mapping by Ozon offerId + SKU. Cached. */
  async lookup(storeId: string, ozonOfferId: string, ozonSku: number): Promise<SkuMapping | null> {
    const cacheKey = `${storeId}:${ozonOfferId}:${ozonSku}`;
    const cached = await cache.cachedGet<SkuMapping>("sku:mapping", cacheKey);
    if (cached) return cached;

    if (!this.db) return null;
    const rows = await this.db.all<Record<string, unknown>>(
      "SELECT * FROM sku_1688_mapping WHERE store_id = ? AND ozon_offer_id = ? AND ozon_sku = ?",
      [storeId, ozonOfferId, ozonSku]
    );
    if (rows.length === 0) return null;

    const r = rows[0];
    const mapping: SkuMapping = {
      id: r.id as string, storeId: r.store_id as string, ozonOfferId: r.ozon_offer_id as string, ozonSku: r.ozon_sku as number,
      source1688Url: r.source_1688_url as string, offer1688Id: r.offer_1688_id as string | undefined,
      sku1688Id: r.sku_1688_id as string | undefined, purchasePriceCny: r.purchase_price_cny as number,
      freightAddress: (r.freight_address as string) || "义乌市某某货代中转仓",
      weightKg: (r.weight_kg as number) || 0.3, profitThreshold: (r.profit_threshold as number) || 0.10,
      ragImageVectorJson: r.rag_image_vector_json as string | undefined,
      lastVerified: r.last_verified as string | undefined, createdAt: r.created_at as string, updatedAt: r.updated_at as string,
    };
    await cache.cachedSet("sku:mapping", cacheKey, mapping, TTL.STORE_CONFIG);
    return mapping;
  }

  /** List all mappings for a store */
  async listByStore(storeId: string, limit = 100): Promise<SkuMapping[]> {
    if (!this.db) return [];
    const rows = await this.db.all<Record<string, unknown>>(
      "SELECT * FROM sku_1688_mapping WHERE store_id = ? ORDER BY updated_at DESC LIMIT ?",
      [storeId, limit]
    );
    return rows.map((r) => ({
      id: r.id as string, storeId: r.store_id as string, ozonOfferId: r.ozon_offer_id as string, ozonSku: r.ozon_sku as number,
      source1688Url: r.source_1688_url as string, offer1688Id: r.offer_1688_id as string | undefined,
      sku1688Id: r.sku_1688_id as string | undefined, purchasePriceCny: r.purchase_price_cny as number,
      freightAddress: (r.freight_address as string) || "", weightKg: (r.weight_kg as number) || 0.3,
      profitThreshold: (r.profit_threshold as number) || 0.10,
      lastVerified: r.last_verified as string | undefined, createdAt: r.created_at as string, updatedAt: r.updated_at as string,
    }));
  }

  /** Auto-calculate profit for a mapping + current Ozon selling price */
  async checkProfit(storeId: string, ozonOfferId: string, ozonSku: number, ozonSellingPriceRub: number): Promise<ProfitCheckResult | null> {
    const mapping = await this.lookup(storeId, ozonOfferId, ozonSku);
    if (!mapping) return null;

    const fx = await getExchangeRate();
    const profit = calculateProfit({
      costCny: mapping.purchasePriceCny,
      sellingPriceRub: ozonSellingPriceRub,
      exchangeRate: fx.rate,
      weightKg: mapping.weightKg,
      shippingCostCny: 80 * mapping.weightKg, // cross-border estimate
    });

    const logisticsCostRub = (80 * mapping.weightKg) * fx.rate;
    const platformFeeRub = ozonSellingPriceRub * 0.15;

    return {
      passed: profit.marginPercent >= mapping.profitThreshold * 100,
      ozonSellingPriceRub,
      purchaseCostCny: mapping.purchasePriceCny,
      logisticsCostRub: Math.round(logisticsCostRub),
      platformFeeRub: Math.round(platformFeeRub),
      netProfitRub: profit.grossProfitRub,
      marginPercent: profit.marginPercent,
    };
  }

  /** RAG-assisted: search for similar 1688 products when source link is broken */
  async findReplacement(ozonOfferId: string, ozonSku: number): Promise<string | null> {
    try {
      // Use RAG v2 to search for similar products
      if (process.env.RAG_ENABLE !== "false") {
        const { RagV2Service } = await import("./rag-v2/service.js");
        const { getDb } = await import("../db/connection.js");
        const db = await getDb().catch(() => null);
        if (db) {
          const rag = new RagV2Service(db);
          await rag.init();
          const results = await rag.search({ collection: "success_copy", query: `${ozonOfferId} sku:${ozonSku}`, topK: 3 });
          if (results.length > 0) {
            return results[0].doc.metadata?.sourceUrl || null;
          }
        }
      }
    } catch { /* RAG unavailable */ }
    return null;
  }

  /** Delete a mapping */
  async delete(storeId: string, ozonOfferId: string, ozonSku: number): Promise<void> {
    if (!this.db) return;
    await this.db.run("DELETE FROM sku_1688_mapping WHERE store_id = ? AND ozon_offer_id = ? AND ozon_sku = ?", [storeId, ozonOfferId, ozonSku]);
    await cache.cachedDel("sku:mapping", `${storeId}:${ozonOfferId}:${ozonSku}`);
  }
}