import { ProcurementState } from "../state.js";
// ============================================================
// Node 3: Profit Calculation — determine if order is profitable
// ============================================================

import type { ProfitResult } from "../state.js";
type StateType = typeof ProcurementState.State;
import { logger } from "@onzo/logger";

export async function calculateProfitNode(
  state: StateType,
): Promise<Partial<StateType>> {
  const order = state.ozonOrder;
  const matches = state.sourceMatches;

  if (!order) {
    return { profitError: "No order data", profit: null };
  }

  logger.info({ postingNumber: order.postingNumber }, "LangGraph: calculating profit");

  try {
    const exchangeRate = await fetchExchangeRate();
    const totalCostCny = matches.reduce((sum: number, m) => sum + m.purchasePriceCny, 0);
    const totalRevenueRub = order.totalPriceRub;

    // Rough logistics estimate: 300 RUB per kg
    const totalWeight = matches.reduce((sum: number, m: { weightKg: number }) => sum + m.weightKg, 0.5);
    const logisticsRub = totalWeight * 300;

    // Platform fee: ~10% of revenue
    const platformFeeRub = totalRevenueRub * 0.10;

    const netProfitRub = totalRevenueRub - (totalCostCny * exchangeRate) - logisticsRub - platformFeeRub;
    const marginPercent = totalRevenueRub > 0 ? (netProfitRub / totalRevenueRub) * 100 : 0;

    const isProfitable = marginPercent >= parseFloat(process.env.MANUAL_PROFIT_THRESHOLD_MARGIN || "0.10") * 100;

    const result: ProfitResult = {
      totalCostCny,
      totalRevenueRub,
      exchangeRate,
      netProfitRub: Math.round(netProfitRub * 100) / 100,
      marginPercent: Math.round(marginPercent * 100) / 100,
      isProfitable,
    };

    logger.info({ postingNumber: order.postingNumber, ...result },
      "LangGraph: profit calculated");

    return { profit: result, profitError: "" };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ err: msg }, "LangGraph: profit calculation failed");
    return { profitError: msg, profit: null };
  }
}

async function fetchExchangeRate(): Promise<number> {
  try {
    const resp = await fetch("https://open.er-api.com/v6/latest/CNY");
    const data = await resp.json() as { rates?: { RUB?: number } };
    return data.rates?.RUB || 11.5;
  } catch {
    return 11.5; // fallback
  }
}
