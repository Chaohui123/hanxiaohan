import { logger } from "@onzo/logger";
import { getDb } from "../db/connection.js";
import { getActiveStoreConfigs } from "../db/models.js";
import { decrypt, isEncrypted } from "./crypto.js";
import { getExchangeRate } from "./exchange-rate.js";

export const OPERATIONS_ANALYTICS_METRICS = [
  "hits_view",
  "hits_tocart",
  "ordered_units",
  "cancellations",
  "delivered_units",
  "revenue",
] as const;

export const OPERATIONS_GROUP_PRIORITY = [
  "ORDER_VALIDATION",
  "WINTER_PRIORITY",
  "CARD_REPAIR",
  "COLD_START",
  "WATCH",
] as const;

export type OperationsGroup = typeof OPERATIONS_GROUP_PRIORITY[number];
export type OperationsDays = 1 | 7 | 30;
type SourceState = "ok" | "degraded" | "error" | "not_loaded";
type RequiredSource = "analytics" | "products";

export interface OperationsPeriod {
  days: OperationsDays;
  dateFrom: string;
  dateTo: string;
}

export interface OperationsSourceStatus {
  analytics: SourceState;
  products: SourceState;
  price: SourceState;
  stock: SourceState;
  cost: SourceState;
}

export interface OperationsTotals {
  views: number;
  carts: number;
  orderedUnits: number;
  cancellations: number;
  deliveredUnits: number;
  orderedRevenueRub: number;
  cartRatePct: number;
  orderRatePct: number;
  stock: number | null;
}

export interface OperationsBoardItem extends OperationsTotals {
  offerId: string;
  sku: number;
  name: string;
  currentPriceRub: number | null;
  minPriceRub: number | null;
  costCny: number;
  group: OperationsGroup;
  warnings: string[];
}

export interface OperationsBoardResponse {
  success: true;
  period: OperationsPeriod;
  totals: OperationsTotals;
  items: OperationsBoardItem[];
  sourceStatus: OperationsSourceStatus;
}

export interface OperationsBoardErrorResponse {
  success: false;
  period: OperationsPeriod;
  totals: null;
  items: [];
  sourceStatus: OperationsSourceStatus;
  error: string;
}

interface Funnel {
  views: number;
  carts: number;
  orderedUnits: number;
  cancellations: number;
  deliveredUnits: number;
  orderedRevenueRub: number;
}

interface ProductRow {
  offerId: string;
  sku: number;
  productId: number;
  name: string;
}

interface AnalyticsApiRow {
  dimensions?: Array<{ id?: string | number }>;
  metrics?: Array<number | string>;
}

interface AnalyticsApiResponse {
  result?: { data?: AnalyticsApiRow[] };
}

interface OzonReadClient {
  request<T>(method: "GET" | "POST", path: string, body: unknown): Promise<T>;
}

const ORDERED_REVENUE_WARNING = "ORDERED_REVENUE_NOT_ACTUAL_RECEIPTS: orderedRevenueRub is order-based revenue, not settled receipts; no estimated net profit is calculated.";
const ORDER_VALIDATION_OFFER_IDS = new Set(["MAR-YAM-61N-01", "MAR-YAM-61N-CABLE-01"]);

export class OperationsBoardSourceError extends Error {
  constructor(
    public readonly source: RequiredSource,
    public readonly period: OperationsPeriod,
    message: string,
  ) {
    super(message);
    this.name = "OperationsBoardSourceError";
  }
}

export function getOperationsPeriod(days: OperationsDays, now = new Date()): OperationsPeriod {
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - days + 1);
  return {
    days,
    dateFrom: from.toISOString().slice(0, 10),
    dateTo: now.toISOString().slice(0, 10),
  };
}

export function classifyOperationsGroup(offerId: string, views: number, carts: number): OperationsGroup {
  const offer = offerId.toUpperCase();
  if (ORDER_VALIDATION_OFFER_IDS.has(offerId)) return "ORDER_VALIDATION";
  if (offer.includes("GRILLE") || offer.includes("VM34") || offer.includes("35X1126")) return "WINTER_PRIORITY";
  if (views >= 50 && carts === 0) return "CARD_REPAIR";
  if (views < 50) return "COLD_START";
  return "WATCH";
}

export function mapOperationsAnalytics(response: AnalyticsApiResponse): Map<string, Funnel> {
  const rows = response.result?.data;
  if (!Array.isArray(rows)) throw new Error("Analytics response is missing result.data");

  const bySku = new Map<string, Funnel>();
  for (const row of rows) {
    const sku = String(row.dimensions?.[0]?.id ?? "").trim();
    if (!sku || !Array.isArray(row.metrics) || row.metrics.length < OPERATIONS_ANALYTICS_METRICS.length) {
      throw new Error("Analytics row does not match the requested sku/metric layout");
    }
    const values = row.metrics.slice(0, OPERATIONS_ANALYTICS_METRICS.length).map((value, index) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        throw new Error(`Analytics metric ${OPERATIONS_ANALYTICS_METRICS[index]} is not numeric`);
      }
      return parsed;
    });
    const current = bySku.get(sku) ?? emptyFunnel();
    current.views += values[0];
    current.carts += values[1];
    current.orderedUnits += values[2];
    current.cancellations += values[3];
    current.deliveredUnits += values[4];
    current.orderedRevenueRub += values[5];
    bySku.set(sku, current);
  }
  return bySku;
}

export function operationsBoardErrorBody(error: OperationsBoardSourceError): OperationsBoardErrorResponse {
  return {
    success: false,
    period: error.period,
    totals: null,
    items: [],
    sourceStatus: {
      analytics: error.source === "analytics" ? "error" : "not_loaded",
      products: error.source === "products" ? "error" : "ok",
      price: "not_loaded",
      stock: "not_loaded",
      cost: "not_loaded",
    },
    error: error.message,
  };
}

export async function getOperationsBoard(days: OperationsDays, now = new Date()): Promise<OperationsBoardResponse> {
  const period = getOperationsPeriod(days, now);
  let client: OzonReadClient;
  try {
    const stores = await getActiveStoreConfigs();
    const store = stores[0];
    if (!store) throw new Error("No active store config");
    const apiKey = isEncrypted(store.apiKey) ? decrypt(store.apiKey) : store.apiKey;
    const { AuthManager, OzonClient } = await import("@onzo/ozon-api-wrapper");
    const auth = new AuthManager({ clients: [{ clientId: store.clientId, apiKey, storeId: store.storeId }] });
    client = new OzonClient({ auth });
  } catch (error) {
    throw new OperationsBoardSourceError("products", period, `Ozon client setup failed: ${(error as Error).message}`);
  }

  let products: ProductRow[];
  try {
    const listResp = await client.request<{ result?: { items?: Array<{ product_id?: number }> } }>(
      "POST", "/v3/product/list", { filter: { visibility: "ALL" }, limit: 100 },
    );
    const productIds = (listResp.result?.items ?? [])
      .map((item) => Number(item.product_id))
      .filter((id) => Number.isFinite(id) && id > 0);
    const infoResp = productIds.length > 0
      ? await client.request<{ items?: Array<{ id?: number; sku?: number; offer_id?: string; name?: string; statuses?: { status_name?: string } }> }>(
        "POST", "/v3/product/info/list", { product_id: productIds },
      )
      : { items: [] };
    products = (infoResp.items ?? [])
      .filter((item) => item.statuses?.status_name !== "Не продается")
      .map((item) => ({
        offerId: String(item.offer_id ?? "").trim(),
        sku: Number(item.sku),
        productId: Number(item.id),
        name: String(item.name || item.offer_id || ""),
      }));
    if (products.some((item) => !item.offerId || !Number.isFinite(item.sku) || item.sku <= 0 || !Number.isFinite(item.productId))) {
      throw new Error("Product info is missing id, sku, or offer_id");
    }
  } catch (error) {
    throw new OperationsBoardSourceError("products", period, `Ozon product fetch failed: ${(error as Error).message}`);
  }

  let analyticsBySku: Map<string, Funnel>;
  try {
    const analyticsResp = await client.request<AnalyticsApiResponse>("POST", "/v1/analytics/data", {
      date_from: period.dateFrom,
      date_to: period.dateTo,
      metrics: [...OPERATIONS_ANALYTICS_METRICS],
      dimension: ["sku"],
      filters: [],
      sort: [],
      limit: 1000,
      offset: 0,
    });
    analyticsBySku = mapOperationsAnalytics(analyticsResp);
  } catch (error) {
    throw new OperationsBoardSourceError("analytics", period, `Ozon analytics fetch failed: ${(error as Error).message}`);
  }

  const sourceStatus: OperationsSourceStatus = {
    analytics: "ok",
    products: "ok",
    price: "not_loaded",
    stock: "not_loaded",
    cost: "not_loaded",
  };
  const sharedWarnings = [ORDERED_REVENUE_WARNING];
  let priceWarning: string | null = null;
  let stockWarning: string | null = null;
  let costWarning: string | null = null;

  let cnyToRub = 11.5;
  try {
    const rate = await getExchangeRate();
    cnyToRub = rate.rate;
    if (!rate.reliable) {
      sourceStatus.price = "degraded";
      priceWarning = "EXCHANGE_RATE_UNRELIABLE: CNY prices were converted with a fallback or unreliable exchange rate.";
    }
  } catch {
    sourceStatus.price = "degraded";
    priceWarning = "EXCHANGE_RATE_FALLBACK: CNY prices were converted with the fallback rate 11.5.";
  }

  const priceByOffer = new Map<string, { currentPriceRub: number | null; minPriceRub: number | null }>();
  try {
    const priceResp = await client.request<{ items?: Array<{ offer_id?: string; price?: { price?: string | number; min_price?: string | number } }> }>(
      "POST", "/v5/product/info/prices", {
        filter: { product_id: products.map((item) => item.productId).map(String), visibility: "ALL" },
        limit: 100,
      },
    );
    for (const row of priceResp.items ?? []) {
      const offerId = String(row.offer_id ?? "").trim();
      if (!offerId) continue;
      priceByOffer.set(offerId, {
        currentPriceRub: cnyAmountToRub(row.price?.price, cnyToRub),
        minPriceRub: cnyAmountToRub(row.price?.min_price, cnyToRub),
      });
    }
    if (sourceStatus.price !== "degraded") sourceStatus.price = "ok";

    const actionPriceByProduct = new Map<number, number>();
    try {
      const actionId = parseInt((process.env.ACTION_WATCH_IDS || "1977747").split(",")[0].trim(), 10) || 1977747;
      const actionResp = await client.request<{ products?: Array<{ id?: number; action_price?: { amount?: string | number } }> }>(
        "POST", "/v2/actions/products", { action_id: actionId, limit: 100 },
      );
      for (const row of actionResp.products ?? []) {
        const price = cnyAmountToRub(row.action_price?.amount, cnyToRub);
        const productId = Number(row.id);
        if (price !== null && price > 0 && Number.isFinite(productId)) actionPriceByProduct.set(productId, price);
      }
    } catch (error) {
      sourceStatus.price = "degraded";
      priceWarning = "ACTION_PRICE_UNAVAILABLE: currentPriceRub uses the v5 list price because promotional prices could not be fetched.";
      logger.warn({ err: (error as Error).message }, "Operations board action prices unavailable");
    }
    for (const product of products) {
      const actionPrice = actionPriceByProduct.get(product.productId);
      if (actionPrice !== undefined) {
        const current = priceByOffer.get(product.offerId) ?? { currentPriceRub: null, minPriceRub: null };
        priceByOffer.set(product.offerId, { ...current, currentPriceRub: actionPrice });
      }
    }
  } catch (error) {
    sourceStatus.price = "error";
    priceWarning = "PRICE_UNAVAILABLE: v5 price fetch failed; currentPriceRub and minPriceRub are null, not zero.";
    logger.warn({ err: (error as Error).message }, "Operations board prices unavailable");
  }

  const stockByOffer = new Map<string, number>();
  try {
    const stockResp = await client.request<{ items?: Array<{ offer_id?: string; stocks?: Array<{ present?: number }> }> }>(
      "POST", "/v4/product/info/stocks", {
        filter: { product_id: products.map((item) => item.productId).map(String), visibility: "ALL" },
        limit: 100,
      },
    );
    for (const row of stockResp.items ?? []) {
      const offerId = String(row.offer_id ?? "").trim();
      if (offerId) stockByOffer.set(offerId, (row.stocks ?? []).reduce((sum, stock) => sum + (Number(stock.present) || 0), 0));
    }
    sourceStatus.stock = "ok";
  } catch (error) {
    sourceStatus.stock = "error";
    stockWarning = "STOCK_UNAVAILABLE: v4 stock fetch failed; stock and totals.stock are null, not zero.";
    logger.warn({ err: (error as Error).message }, "Operations board stocks unavailable");
  }

  const costByOffer = new Map<string, number>();
  try {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const rows = await db.all<{ ozon_offer_id: string; purchase_price_cny: number }>(
      `SELECT ozon_offer_id, MAX(purchase_price_cny) AS purchase_price_cny
       FROM sku_1688_mapping GROUP BY ozon_offer_id`,
    );
    for (const row of rows) costByOffer.set(String(row.ozon_offer_id), Number(row.purchase_price_cny) || 0);
    sourceStatus.cost = "ok";
  } catch (error) {
    sourceStatus.cost = "error";
    costWarning = "COST_UNAVAILABLE: cost mapping query failed; costCny is 0 and must not be treated as a confirmed zero cost.";
    logger.warn({ err: (error as Error).message }, "Operations board costs unavailable");
  }

  const items = products.map((product): OperationsBoardItem => {
    const funnel = analyticsBySku.get(String(product.sku)) ?? emptyFunnel();
    const price = priceByOffer.get(product.offerId);
    const stock = stockByOffer.get(product.offerId);
    const warnings = [...sharedWarnings];
    if (priceWarning) warnings.push(priceWarning);
    if (stockWarning) warnings.push(stockWarning);
    if (costWarning) warnings.push(costWarning);
    if (sourceStatus.price !== "error" && (!price || price.currentPriceRub === null || price.minPriceRub === null)) {
      warnings.push("PRICE_ROW_INCOMPLETE: currentPriceRub or minPriceRub is unavailable and returned as null.");
    }
    if (sourceStatus.stock === "ok" && stock === undefined) {
      warnings.push("STOCK_ROW_MISSING: no stock row was returned for this SKU; stock is null, not zero.");
    }
    if (sourceStatus.cost === "ok" && !costByOffer.has(product.offerId)) {
      warnings.push("COST_MAPPING_MISSING: no 1688 cost mapping was found; costCny is 0 and is not a confirmed zero cost.");
    }
    return {
      offerId: product.offerId,
      sku: product.sku,
      name: product.name,
      ...funnel,
      cartRatePct: percentage(funnel.carts, funnel.views),
      orderRatePct: percentage(funnel.orderedUnits, funnel.views),
      currentPriceRub: price?.currentPriceRub ?? null,
      minPriceRub: price?.minPriceRub ?? null,
      stock: stock ?? null,
      costCny: costByOffer.get(product.offerId) ?? 0,
      group: classifyOperationsGroup(product.offerId, funnel.views, funnel.carts),
      warnings,
    };
  }).sort((a, b) => {
    const priority = OPERATIONS_GROUP_PRIORITY.indexOf(a.group) - OPERATIONS_GROUP_PRIORITY.indexOf(b.group);
    return priority || a.offerId.localeCompare(b.offerId);
  });

  return {
    success: true,
    period,
    totals: {
      views: sum(items, "views"),
      carts: sum(items, "carts"),
      orderedUnits: sum(items, "orderedUnits"),
      cancellations: sum(items, "cancellations"),
      deliveredUnits: sum(items, "deliveredUnits"),
      orderedRevenueRub: round(sum(items, "orderedRevenueRub")),
      cartRatePct: percentage(sum(items, "carts"), sum(items, "views")),
      orderRatePct: percentage(sum(items, "orderedUnits"), sum(items, "views")),
      stock: sourceStatus.stock === "ok" && items.every((item) => item.stock !== null)
        ? items.reduce((total, item) => total + (item.stock ?? 0), 0)
        : null,
    },
    items,
    sourceStatus,
  };
}

function emptyFunnel(): Funnel {
  return { views: 0, carts: 0, orderedUnits: 0, cancellations: 0, deliveredUnits: 0, orderedRevenueRub: 0 };
}

function cnyAmountToRub(value: string | number | undefined, rate: number): number | null {
  if (value === undefined || value === null || value === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? round(amount * rate) : null;
}

function percentage(numerator: number, denominator: number): number {
  return denominator > 0 ? round(numerator / denominator * 100) : 0;
}

function sum(items: OperationsBoardItem[], key: keyof Funnel): number {
  return items.reduce((total, item) => total + item[key], 0);
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
