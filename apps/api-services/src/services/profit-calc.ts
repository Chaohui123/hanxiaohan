// ============================================================
// Profit Calculator — CNY cost → RUB revenue analysis
// ============================================================

export interface ProfitBreakdown {
  costCny: number;
  exchangeRate: number;
  costRub: number;
  sellingPriceRub: number;
  ozonCommissionRub: number;
  logisticsRub: number;
  grossProfitRub: number;
  grossMargin: number; // in RUB
  marginPercent: number; // 0-100
  profitable: boolean;
}

/** Ozon commission rates by category (approximate, service-side actual) */
const COMMISSION_RATES: Record<string, number> = {
  electronics: 0.08, accessories: 0.10, auto: 0.10, home: 0.12,
  clothes: 0.12, shoes: 0.12, beauty: 0.12, default: 0.10,
};

export function calculateProfit(params: {
  costCny: number;
  sellingPriceRub: number;
  exchangeRate: number;
  category?: string;
  weightKg?: number;
}): ProfitBreakdown {
  const costRub = Math.round(params.costCny * params.exchangeRate);
  const commissionRate = COMMISSION_RATES[params.category ?? "default"] ?? COMMISSION_RATES.default;
  const ozonCommissionRub = Math.round(params.sellingPriceRub * commissionRate);

  // Logistics estimate: ~200 RUB base + 50 RUB per kg
  const logisticsRub = 200 + Math.round((params.weightKg ?? 0.5) * 50);

  const grossProfitRub = params.sellingPriceRub - costRub - ozonCommissionRub - logisticsRub;
  const marginPercent = params.sellingPriceRub > 0
    ? Math.round((grossProfitRub / params.sellingPriceRub) * 100)
    : 0;

  return {
    costCny: params.costCny,
    exchangeRate: params.exchangeRate,
    costRub,
    sellingPriceRub: params.sellingPriceRub,
    ozonCommissionRub,
    logisticsRub,
    grossProfitRub,
    grossMargin: grossProfitRub,
    marginPercent,
    profitable: grossProfitRub > 0,
  };
}
