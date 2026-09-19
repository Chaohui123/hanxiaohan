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

// ---- Rate-limit resilience (2026-09-11 限流事故修复) ----
// Ozon posting list 端点是【每秒】级限流；旧配置 30/min + maxBurst 20
// 允许单秒突发 20 个请求,叠加 webhook/库存等并发任务后必然 429。
// 这里把配额对齐到秒级,并在 list 调用间加固定间隔 + 限流感知退避重试。
const LIST_CALL_GAP_MS = 800;
const RATE_LIMIT_MAX_RETRIES = 3;

// ---- 成本口径（2026-09-19 利润核算实证） ----
/** 打包费 5 CNY/单（用户确认）；采购→货代段包邮，无国内运费 */
const PACKAGING_FEE_CNY = 5;
/**
 * 国际物流分档（RUB，globalcalculator.ozon.ru China/Dongguan→Russia 8/20 实测，
 * 与 promo-agent decision-engine 底价公式同口径；月报 realization 出来后校准）：
 * XS(≤135¥ 且 ≤500g) 95₽ ｜ Small(135-635¥ 且 ≤2kg) 300₽ ｜ Premium Small(635¥+ 且 ≤5kg) 2161₽
 */
function logisticsFeeRub(priceCny: number, weightG: number): number {
  if (priceCny <= 135 && weightG <= 500) return 95;
  if (priceCny <= 635 && weightG <= 2000) return 300;
  return 2161;
}

function isRateLimitError(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  return e?.name === "RateLimitError" || /rate limit/i.test(e?.message ?? "");
}

/** 熔断冷却中的跳过（非失败）：CircuitBreakerOpenError — 冷却后重试，不计入失败 streak */
function isCircuitOpenError(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  return e?.name === "CircuitBreakerOpenError" || /circuit breaker is open/i.test(e?.message ?? "");
}

function rateLimitRetryAfterMs(err: unknown): number | undefined {
  return (err as { retryAfterMs?: number }).retryAfterMs;
}

/** Retry a list call with backoff when Ozon returns a per-second rate limit. */
async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRateLimitError(err) || attempt === RATE_LIMIT_MAX_RETRIES) throw err;
      // 优先服从 Ozon 的 Retry-After,否则指数退避 2s/4s/8s
      const backoff = Math.max(rateLimitRetryAfterMs(err) ?? 0, 2000 * Math.pow(2, attempt));
      logger.warn({ attempt: attempt + 1, backoffMs: backoff }, "OzonOrderSync: rate limited, backing off");
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

// ---- Types ----

interface StoreSyncResult {
  storeId: string;
  newOrders: number;
  flaggedOrders: number;
  skippedOrders: number;
  errors: string[];
  /** 熔断冷却中跳过的状态（非失败——冷却后会补，不计入失败 streak，2026-09-12 误报告警修复） */
  delayedBreakers: string[];
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
        // 熔断冷却跳过只记 info 日志，不进 errors（非失败，冷却后会补——2026-09-12 误报告警修复）
        if (result.delayedBreakers.length > 0) {
          logger.info({ storeId, delayed: result.delayedBreakers }, "OzonOrderSync: statuses delayed by circuit breaker cooldown");
        }
      } catch (err) {
        errors.push(`[${storeId}] ${(err as Error).message}`);
      } finally {
        await releaseLock(storeId, lockToken);
      }
    }

    // Include error details — a bare count hides persistent failures
    // (a sync that errors every cycle looks identical to a healthy idle one).
    logger[errors.length > 0 ? "warn" : "info"]({ storesScanned: stores.length, totalOrders, newOrders, flaggedOrders, errors },
      "OzonOrderSync: All stores synced");

    return { storesScanned: stores.length, totalOrders, newOrders, flaggedOrders, skippedOrders, errors };
  }

  /** Sync a single store by storeId. Fetches FBS + FBO, enriches, persists. */
  async syncStore(storeId: string, clientId: string, apiKey: string): Promise<StoreSyncResult> {
    const errors: string[] = [];
    const delayedBreakers: string[] = [];
    let newOrders = 0;
    let flaggedOrders = 0;
    let skippedOrders = 0;

    const resolvedKey = isEncrypted(apiKey) ? decrypt(apiKey) : apiKey;

    // Create per-store OzonClient — limiter aligned to Ozon's per-second quota.
    // maxBurst 1: 每个 sync 周期新建 client,开局不能突发;稳态 5 req/s 留余量。
    const { AuthManager } = await import("@onzo/ozon-api-wrapper");
    const auth = new AuthManager({ clients: [{ clientId, apiKey: resolvedKey, storeId }] });
    const ozonClient = new (await import("@onzo/ozon-api-wrapper")).OzonClient({
      auth,
      rateLimiterConfig: { tokensPerInterval: 2, intervalMs: 1000, maxBurst: 1 },
    });
    const orderClient = new OzonOrderClient(ozonClient);

    const statuses = ["awaiting_packaging", "awaiting_deliver", "delivering", "cancelled", "delivered"];

    let firstCall = true;
    const paceListCalls = async () => {
      // 请求间固定间隔,避免 10 次连续调用紧贴每秒配额上限
      if (firstCall) { firstCall = false; return; }
      await new Promise((r) => setTimeout(r, LIST_CALL_GAP_MS));
    };

    for (const status of statuses) {
      // FBS
      try {
        await paceListCalls();
        const fbsPostings = await withRateLimitRetry(() => orderClient.listPostings({ status: status as never, limit: 100 }));
        for (const p of fbsPostings) {
          const result = await this.processPosting(p, storeId);
          if (result === "new") newOrders++;
          else if (result === "flagged") { newOrders++; flaggedOrders++; }
          else skippedOrders++;
        }
      } catch (err) {
        if (isCircuitOpenError(err)) delayedBreakers.push(`FBS/${status}`);
        else errors.push(`FBS/${status}: ${(err as Error).message}`);
      }

      // FBO
      try {
        await paceListCalls();
        const fboPostings = await withRateLimitRetry(() => orderClient.listFboPostings({ status: status as never, limit: 100 }));
        for (const p of fboPostings) {
          const result = await this.processPosting(p, storeId);
          if (result === "new") newOrders++;
          else if (result === "flagged") { newOrders++; flaggedOrders++; }
          else skippedOrders++;
        }
      } catch (err) {
        if (isCircuitOpenError(err)) delayedBreakers.push(`FBO/${status}`);
        else errors.push(`FBO/${status}: ${(err as Error).message}`);
      }
    }

    return { storeId, newOrders, flaggedOrders, skippedOrders, errors, delayedBreakers };
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

    // ---- 金额与利润口径（2026-09-19 修复） ----
    // posting.price 是订单货币金额（跨境店=CNY 定价），不能直接当 RUB 存。
    // total_price_rub 统一为【到手口径 RUB】：有 payout（financial_data）用真实值，
    // 否则按 CNY×汇率 换算（列表未带财务数据的兜底，利润标 needs_review）。
    const rate = await this.getExchangeRate();
    const isCny = (posting.currencyCode || "CNY") === "CNY";
    const priceRubConverted = Math.round((isCny ? posting.price * rate : posting.price) * 100) / 100;
    const hasPayout = (posting.payout ?? 0) > 0;
    const totalPriceRub = hasPayout ? Math.round(posting.payout * 100) / 100 : priceRubConverted;

    // 成本：采购Σ + 打包费 5 CNY/单（取消单不计成本）
    if (posting.status !== "cancelled") totalCostCny += PACKAGING_FEE_CNY;

    // 物流档：按订单售价 CNY 与最重件重量分档
    const maxWeightG = Math.max(0, ...enrichedProducts.map((p) => (p.weightKg ?? 0) * 1000));
    const logisticsRub = posting.status === "cancelled" ? 0
      : logisticsFeeRub(isCny ? posting.price : posting.price / rate, maxWeightG > 0 ? maxWeightG : Number.POSITIVE_INFINITY);

    // 净利润（到手口径）：payout − 采购 − 打包 − 国际物流
    // 无 payout 时佣金未扣（换算口径偏乐观），标 needs_review 人工复核
    const totalProfitRub = posting.status === "cancelled" ? 0
      : Math.round((totalPriceRub - totalCostCny * rate - logisticsRub) * 100) / 100;
    const marginPercent = totalPriceRub > 0 && posting.status !== "cancelled"
      ? Math.round((totalProfitRub / totalPriceRub) * 1000) / 10 : 0;
    if (!hasPayout && posting.status !== "cancelled") allProfitOk = false;

    const needsReview = !hasSource || !allProfitOk || (!hasPayout && posting.status !== "cancelled");

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
        totalPriceRub, Math.round(totalCostCny * 100) / 100, totalProfitRub,
        marginPercent,
        hasSource ? 1 : 0, allProfitOk ? 1 : 0, needsReview ? 1 : 0,
        posting.trackingNumber ?? null, now, now,
      ]
    );

    logger.info({ storeId, postingNumber: posting.postingNumber, needsReview, marginPercent },
      "OzonOrderSync: Order processed");

    // ---- Auto purchase record ----
    // 新订单（非取消）必须在采购列表出现待处理记录并计入成本（2026-09-05 用户要求）；
    // ON CONFLICT DO NOTHING 幂等，webhook 路径先到也不会重复
    const isNew = existing.length === 0;
    if (isNew && posting.status !== "cancelled") {
      const { ensurePendingPurchase } = await import("./purchase-auto.js");
      await ensurePendingPurchase(this.db, {
        storeId,
        postingNumber: posting.postingNumber,
        ozonOrderId: posting.orderId,
        products: enrichedProducts.map((p) => ({ offerId: p.offerId, sku: p.sku, quantity: p.quantity })),
      }).catch((err) => logger.warn({ err: (err as Error).message, postingNumber: posting.postingNumber }, "Auto purchase record failed"));
    }

    // ---- Notification (fallback path) ----
    // The webhook path (drain → processNewOrder) writes local_orders (keyed by
    // order_number) and notifies; skip here when that already happened.
    // First-seen wins. Match both the bare order_number and the package-level
    // posting_number.
    const becameCancelled = !isNew && existing[0].status !== "cancelled" && posting.status === "cancelled";
    if ((isNew && posting.status !== "cancelled") || becameCancelled) {
      const orderNumber = posting.orderNumber || posting.postingNumber;
      const viaWebhook = await this.db.all<{ x: number }>(
        "SELECT 1 AS x FROM local_orders WHERE posting_number = ? OR posting_number = ? LIMIT 1",
        [orderNumber, posting.postingNumber]
      ).catch(() => [] as Array<{ x: number }>);
      if (viaWebhook.length === 0) {
        const { emitEvent } = await import("./notification-events.js");
        if (isNew) {
          await emitEvent("ORDER_NEW", {
            postingNumber: posting.postingNumber,
            productCount: String(posting.products.length),
            // 到手口径 RUB（posting.price 是订单货币 CNY，勿直报）
            priceRub: String(totalPriceRub),
          }, `order-${posting.postingNumber}`).catch(() => {});
        } else {
          await emitEvent("ORDER_CANCELLED", {
            postingNumber: posting.postingNumber,
          }, `order-${posting.postingNumber}`).catch(() => {});
        }
      }
    }

    return needsReview ? "flagged" : "new";
  }

  /** Enrich a single product with 1688 source URL and real purchase cost. */
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

    // 成本与货源首选 sku_1688_mapping（真实采购价，2026-09-19 修复）：
    // 旧逻辑用 price_history（竞品价格快照表）的售价倒推成本，是错误数据源。
    try {
      const mapRows = await this.db.all<{ purchase_price_cny: number; weight_kg: number; source_1688_url: string }>(
        "SELECT purchase_price_cny, weight_kg, source_1688_url FROM sku_1688_mapping WHERE ozon_offer_id = ? LIMIT 1",
        [product.offerId]
      );
      if (mapRows.length > 0) {
        const m = mapRows[0];
        if (m.source_1688_url && m.source_1688_url !== "manual-input") result.source1688Url = m.source_1688_url;
        if (Number(m.purchase_price_cny) > 0) {
          result.costCny = Number(m.purchase_price_cny);
          const exRate = await this.getExchangeRate();
          // price 为订单货币（跨境=CNY 定价口径），毛利估算同币种相减
          if (result.price > 0) {
            result.profitMargin = Math.round(((result.price - result.costCny) / result.price) * 1000) / 10;
          }
          result.weightKg = Number(m.weight_kg) || undefined;
        }
        return result;
      }
    } catch { /* sku_1688_mapping may not exist in SQLite fallback */ }

    // Fallback: match 1688 source via listing_records（仅货源链接，无成本——无映射不估算成本，标 needs_review）
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
