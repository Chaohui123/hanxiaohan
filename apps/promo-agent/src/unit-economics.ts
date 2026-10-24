import { logger } from "@onzo/logger";

export type PricingBlocker =
  | "FX_UNAVAILABLE"
  | "ORDERS_UNAVAILABLE"
  | "MISSING_COST"
  | "OUT_OF_STOCK"
  | "MISSING_WEIGHT"
  | "INVALID_PRICE"
  | "OGL_UNSUPPORTED";

export interface UnitEconomicsConfig {
  commissionRate: number;
  cpsRate: number;
  electronicServiceRate: number;
  electronicServiceMinRub: number;
  electronicServiceMaxRub: number;
  internationalTransportRate: number;
  returnRate: number;
  packagingCny: number;
  targetNetMarginRate: number;
  astraNetMarginRate: number;
}

export interface UnitEconomicsInput {
  priceRub: number;
  costCny: number;
  weightG: number;
  exchangeRate: number;
  offerId?: string;
  config?: UnitEconomicsConfig;
}

export interface OglPricingContext {
  baseFixedCostRub: number;
  weightG: number;
  exchangeRate: number;
}

export interface UnitEconomicsResult {
  costRub: number;
  packagingRub: number;
  logisticsRub: number;
  fixedCostRub: number;
  variableFeesRub: number;
  unitProfitRub: number;
  marginPercent: number;
  floorPrice: number;
  astraMinPrice: number;
  pricingBlockers: PricingBlocker[];
}

const DEFAULT_CONFIG: UnitEconomicsConfig = {
  commissionRate: 0.20,
  cpsRate: 0.23,
  electronicServiceRate: 0.02,
  electronicServiceMinRub: 15,
  electronicServiceMaxRub: 200,
  internationalTransportRate: 0.0033,
  returnRate: 0.05,
  packagingCny: 5,
  targetNetMarginRate: 0.10,
  astraNetMarginRate: 0.20,
};

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function cpsRateFromEnv(offerId?: string): number {
  const configured = Number(process.env.PROMO_CPS_RATE);
  const fallback = Number.isFinite(configured) && configured >= 0 && configured <= 1 ? configured : DEFAULT_CONFIG.cpsRate;
  const raw = process.env.PROMO_CPS_RATE_OVERRIDES;
  if (!offerId || !raw?.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected an offerId-to-rate object");
    const value = (parsed as Record<string, unknown>)[offerId];
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      logger.warn({ offerId }, "Invalid CPS override rate — using PROMO_CPS_RATE fallback");
      return fallback;
    }
    return value;
  } catch (err) {
    logger.warn({ offerId, err: (err as Error).message }, "Invalid PROMO_CPS_RATE_OVERRIDES — using PROMO_CPS_RATE fallback");
    return fallback;
  }
}

export function unitEconomicsConfigFromEnv(offerId?: string): UnitEconomicsConfig {
  return {
    commissionRate: envNumber("PROMO_COMMISSION_RATE", DEFAULT_CONFIG.commissionRate),
    cpsRate: cpsRateFromEnv(offerId),
    electronicServiceRate: envNumber("PROMO_ELECTRONIC_SERVICE_RATE", DEFAULT_CONFIG.electronicServiceRate),
    electronicServiceMinRub: envNumber("PROMO_ELECTRONIC_SERVICE_MIN_RUB", DEFAULT_CONFIG.electronicServiceMinRub),
    electronicServiceMaxRub: envNumber("PROMO_ELECTRONIC_SERVICE_MAX_RUB", DEFAULT_CONFIG.electronicServiceMaxRub),
    internationalTransportRate: envNumber("PROMO_INTERNATIONAL_TRANSPORT_RATE", DEFAULT_CONFIG.internationalTransportRate),
    returnRate: envNumber("PROMO_RETURN_RATE", DEFAULT_CONFIG.returnRate),
    packagingCny: envNumber("PROMO_PACKAGING_CNY", DEFAULT_CONFIG.packagingCny),
    targetNetMarginRate: envNumber("PROMO_TARGET_NET_MARGIN", DEFAULT_CONFIG.targetNetMarginRate),
    astraNetMarginRate: envNumber("PROMO_ASTRA_NET_MARGIN", DEFAULT_CONFIG.astraNetMarginRate),
  };
}

export function effectivePriceRub(sellerPriceRub: number, actionPriceRub: number): number {
  const seller = Number.isFinite(sellerPriceRub) && sellerPriceRub > 0 ? sellerPriceRub : 0;
  const action = Number.isFinite(actionPriceRub) && actionPriceRub > 0 ? actionPriceRub : 0;
  if (seller > 0 && action > 0) return Math.min(seller, action);
  return seller || action;
}

export function oglLogisticsCny(priceRub: number, weightG: number): number | null {
  if (!(priceRub > 0) || !(weightG > 0) || !Number.isFinite(weightG)) return null;
  if (priceRub <= 1500 && weightG <= 500) return 2.90 + 0.0247 * weightG;
  if (priceRub > 1500 && priceRub <= 7000 && weightG <= 2000) return 15.48 + 0.0242 * weightG;
  return null;
}

export function electronicServiceRub(priceRub: number, config: UnitEconomicsConfig): number {
  return Math.min(
    config.electronicServiceMaxRub,
    Math.max(config.electronicServiceMinRub, priceRub * config.electronicServiceRate),
  );
}

function baseVariableRate(config: UnitEconomicsConfig): number {
  return config.commissionRate + config.cpsRate + config.internationalTransportRate + config.returnRate;
}

export function variableFeesRub(priceRub: number, config: UnitEconomicsConfig): number {
  return priceRub * baseVariableRate(config) + electronicServiceRub(priceRub, config);
}

export function unitProfitRub(priceRub: number, fixedCostRub: number, config: UnitEconomicsConfig): number {
  return priceRub - variableFeesRub(priceRub, config) - fixedCostRub;
}

function solvePrice(targetProfitRub: number, targetMarginRate: number, fixedCostRub: number, config: UnitEconomicsConfig): number {
  const retainedRate = 1 - baseVariableRate(config) - targetMarginRate;
  if (!(retainedRate > config.electronicServiceRate)) return Number.POSITIVE_INFINITY;
  const midPrice = (fixedCostRub + targetProfitRub) / (retainedRate - config.electronicServiceRate);
  const minBoundary = config.electronicServiceMinRub / config.electronicServiceRate;
  const maxBoundary = config.electronicServiceMaxRub / config.electronicServiceRate;
  if (midPrice < minBoundary) return (fixedCostRub + targetProfitRub + config.electronicServiceMinRub) / retainedRate;
  if (midPrice > maxBoundary) return (fixedCostRub + targetProfitRub + config.electronicServiceMaxRub) / retainedRate;
  return midPrice;
}

export function oglFixedCostRub(priceRub: number, context: OglPricingContext): number | null {
  const logisticsCny = oglLogisticsCny(priceRub, context.weightG);
  if (logisticsCny === null || !(context.exchangeRate > 0) || !Number.isFinite(context.exchangeRate)) return null;
  return context.baseFixedCostRub + logisticsCny * context.exchangeRate;
}

function solveOglPrice(targetProfitRub: number, targetMarginRate: number, context: OglPricingContext, config: UnitEconomicsConfig): number {
  const candidates: number[] = [];
  const tiers = context.weightG <= 500 ? ["XS", "Small"] : context.weightG <= 2000 ? ["Small"] : [];
  for (const tier of tiers) {
    const logisticsCny = tier === "XS"
      ? 2.90 + 0.0247 * context.weightG
      : 15.48 + 0.0242 * context.weightG;
    const fixedCostRub = context.baseFixedCostRub + logisticsCny * context.exchangeRate;
    const candidate = solvePrice(targetProfitRub, targetMarginRate, fixedCostRub, config);
    const inTier = tier === "XS"
      ? candidate > 0 && candidate <= 1500
      : candidate > 1500 && candidate <= 7000;
    if (Number.isFinite(candidate) && inTier) candidates.push(candidate);
  }
  // 每档最多一个解；直接枚举两档，无迭代/死循环。异常多解取高价安全侧。
  return candidates.length > 0 ? Math.max(...candidates) : Number.POSITIVE_INFINITY;
}

export function priceForUnitProfit(
  targetProfitRub: number, fixedCostRub: number, config: UnitEconomicsConfig, ogl?: OglPricingContext,
): number {
  return ogl
    ? solveOglPrice(targetProfitRub, 0, ogl, config)
    : solvePrice(targetProfitRub, 0, fixedCostRub, config);
}

export function priceForTargetMargin(
  fixedCostRub: number, targetMarginRate: number, config: UnitEconomicsConfig, ogl?: OglPricingContext,
): number {
  return ogl
    ? solveOglPrice(0, targetMarginRate, ogl, config)
    : solvePrice(0, targetMarginRate, fixedCostRub, config);
}

export function calculateUnitEconomics(input: UnitEconomicsInput): UnitEconomicsResult {
  const config = input.config || unitEconomicsConfigFromEnv(input.offerId);
  const pricingBlockers: PricingBlocker[] = [];
  if (!(input.exchangeRate > 0) || !Number.isFinite(input.exchangeRate)) pricingBlockers.push("FX_UNAVAILABLE");
  if (!(input.costCny > 0) || !Number.isFinite(input.costCny)) pricingBlockers.push("MISSING_COST");
  if (!(input.priceRub > 0) || !Number.isFinite(input.priceRub)) pricingBlockers.push("INVALID_PRICE");
  if (!(input.weightG > 0) || !Number.isFinite(input.weightG)) pricingBlockers.push("MISSING_WEIGHT");

  const validRate = input.exchangeRate > 0 && Number.isFinite(input.exchangeRate) ? input.exchangeRate : 0;
  const validCost = input.costCny > 0 && Number.isFinite(input.costCny) ? input.costCny : 0;
  const costRub = validCost * validRate;
  const packagingRub = config.packagingCny * validRate;
  const logisticsCny = pricingBlockers.length === 0 ? oglLogisticsCny(input.priceRub, input.weightG) : null;
  if (pricingBlockers.length === 0 && logisticsCny === null) pricingBlockers.push("OGL_UNSUPPORTED");
  const logisticsRub = (logisticsCny || 0) * validRate;
  const fixedCostRub = costRub + logisticsRub + packagingRub;

  if (pricingBlockers.length > 0) {
    return {
      costRub, packagingRub, logisticsRub, fixedCostRub,
      variableFeesRub: 0, unitProfitRub: 0, marginPercent: 0,
      floorPrice: 0, astraMinPrice: 0, pricingBlockers,
    };
  }

  const ogl = { baseFixedCostRub: costRub + packagingRub, weightG: input.weightG, exchangeRate: validRate };
  const floorPrice = priceForTargetMargin(ogl.baseFixedCostRub, config.targetNetMarginRate, config, ogl);
  const astraMinPrice = priceForTargetMargin(ogl.baseFixedCostRub, config.astraNetMarginRate, config, ogl);
  if (!Number.isFinite(floorPrice) || !Number.isFinite(astraMinPrice)) pricingBlockers.push("OGL_UNSUPPORTED");
  const fees = variableFeesRub(input.priceRub, config);
  const profit = input.priceRub - fees - fixedCostRub;
  return {
    costRub, packagingRub, logisticsRub, fixedCostRub,
    variableFeesRub: fees,
    unitProfitRub: profit,
    marginPercent: profit / input.priceRub * 100,
    floorPrice: Number.isFinite(floorPrice) ? floorPrice : 0,
    astraMinPrice: Number.isFinite(astraMinPrice) ? astraMinPrice : 0,
    pricingBlockers,
  };
}
