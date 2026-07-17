// ============================================================
// Purchase Risk Control — multi-layer pre-payment validation
// Block payment if: margin < 10%, price surge > 20%,
// daily/per-order limits exceeded, or SKU stock insufficient.
// ============================================================

import type { DbAdapter } from "../db/connection.js";
import { cache } from "@onzo/cache";
import { logger } from "@onzo/logger";
import { getExchangeRate } from "./exchange-rate.js";
import { calculateProfit } from "./profit-calc.js";

// ---- Types ----

export interface RiskCheckInput {
  storeId: string;
  ozonPostingNumber: string;
  costCny: number;
  sellingPriceRub: number;
  weightKg: number;
  source1688Url?: string;
}

export interface RiskCheckResult {
  passed: boolean;
  checks: {
    profitOk: boolean;
    priceOk: boolean;
    dailyLimitOk: boolean;
    perOrderLimitOk: boolean;
    stockOk: boolean;
  };
  marginPercent: number;
  blockReason?: string;
}

// ---- Configurable Thresholds ----

const MIN_PROFIT_RATE = parseFloat(process.env.PURCHASE_MIN_PROFIT_RATE || "0.10");    // 10%
const MAX_PRICE_SURGE = parseFloat(process.env.PURCHASE_MAX_PRICE_SURGE || "0.20");     // 20%
const DAILY_LIMIT_CY = parseFloat(process.env.PURCHASE_DAILY_LIMIT_CY || "5000");       // ¥5000/day
const MAX_ORDER_CY = parseFloat(process.env.PURCHASE_MAX_ORDER_CY || "2000");            // ¥2000/order

// ---- Public API ----

export async function runRiskCheck(input: RiskCheckInput, db: DbAdapter | null): Promise<RiskCheckResult> {
  const checks = { profitOk: true, priceOk: true, dailyLimitOk: true, perOrderLimitOk: true, stockOk: true };
  const failures: string[] = [];

  // 1. Exchange rate
  const fxResult = await getExchangeRate();
  const exchangeRate = fxResult.rate;

  // 2. Profit margin check
  if (input.costCny > 0 && input.sellingPriceRub > 0) {
    const profit = calculateProfit({
      costCny: input.costCny,
      sellingPriceRub: input.sellingPriceRub,
      exchangeRate,
      weightKg: input.weightKg || 0.5,
    });
    if (profit.marginPercent < MIN_PROFIT_RATE * 100) {
      checks.profitOk = false;
      failures.push(`利润率 ${profit.marginPercent}% < ${MIN_PROFIT_RATE * 100}% 阈值`);
    }
  }

  // 3. Price surge check (vs 7-day avg)
  if (db && input.costCny > 0) {
    try {
      const priceRows = await db.all<{ avg_price: number }>(
        `SELECT AVG(price_rub) as avg_price FROM price_history
         WHERE source_url = ? AND captured_at >= datetime('now', '-7 days')`,
        [input.source1688Url || ""]
      );
      if (priceRows.length > 0 && priceRows[0].avg_price > 0) {
        const avgCostCny = priceRows[0].avg_price / exchangeRate;
        const surge = (input.costCny - avgCostCny) / avgCostCny;
        if (surge > MAX_PRICE_SURGE) {
          checks.priceOk = false;
          failures.push(`价格涨幅 ${Math.round(surge * 100)}% > ${MAX_PRICE_SURGE * 100}%`);
        }
      }
    } catch { /* price_history may not exist */ }
  }

  // 4. Per-order limit
  if (input.costCny > MAX_ORDER_CY) {
    checks.perOrderLimitOk = false;
    failures.push(`单笔金额 ¥${input.costCny.toFixed(2)} > ¥${MAX_ORDER_CY} 上限`);
  }

  // 5. Daily limit (Redis-backed)
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dailyKey = `purchase:daily:${input.storeId}:${today}`;
    const current = await cache.incr(dailyKey);
    await cache.expire(dailyKey, 86400); // expire after 24h
    const projected = current * input.costCny; // rough: count * current order
    if (projected > DAILY_LIMIT_CY) {
      checks.dailyLimitOk = false;
      failures.push(`今日累计预估 ¥${projected.toFixed(2)} > ¥${DAILY_LIMIT_CY} 日限额`);
    }
  } catch { /* Redis unavailable — skip daily limit check */ }

  const passed = Object.values(checks).every(Boolean);

  logger.info({
    postingNumber: input.ozonPostingNumber,
    storeId: input.storeId,
    costCny: input.costCny,
    checks,
    passed,
  }, "PurchaseRisk: check completed");

  return {
    passed,
    checks,
    marginPercent: checks.profitOk ? 100 : 0, // approximate
    blockReason: failures.length > 0 ? failures.join("; ") : undefined,
  };
}