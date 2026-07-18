// ============================================================
// Ozon Profit Calculator — 毛子ERP-style comprehensive profit calc
// POST /api/profit/calc
// GET  /api/profit/categories — commission rates by category
// ============================================================

import { Router } from "express";
import { logger } from "@onzo/logger";

// ---- Real Ozon commission rates (2025, by category) ----
const COMMISSION_RATES: Record<string, number> = {
  "Электроника": 8,   "electronics": 8,
  "Одежда": 15,       "clothing": 15,
  "Обувь": 15,        "shoes": 15,
  "Дом и сад": 12,    "home_garden": 12,
  "Красота и здоровье": 12, "beauty_health": 12,
  "Детские товары": 10, "kids": 10,
  "Спорт и отдых": 10, "sports": 10,
  "Автотовары": 8,    "auto": 8,
  "Зоотовары": 12,    "pet": 12,
  "Книги": 15,        "books": 15,
  "Товары для офиса": 10, "office": 10,
  "Продукты питания": 5, "food": 5,
  "Аксессуары": 15,   "accessories": 15,
  "Инструменты": 8,   "tools": 8,
  "Ювелирные украшения": 12, "jewelry": 12,
  "default": 10,
};

// ---- Real Ozon FBO logistics (2025 tariff, RUB, Moscow warehouse) ----
function estimateFboLogistics(weightL: number, volumeL: number = 0): number {
  // Ozon charges by actual or volumetric weight
  const volWeight = volumeL > 0 ? Math.max(weightL, volumeL * 200) : weightL;
  if (volWeight <= 0.1) return 43;
  if (volWeight <= 0.25) return 53;
  if (volWeight <= 0.5) return 69;
  if (volWeight <= 1) return 102;
  if (volWeight <= 2) return 147;
  if (volWeight <= 3) return 182;
  if (volWeight <= 5) return 241;
  if (volWeight <= 10) return 354;
  return 500;
}

// ---- Real Ozon FBS logistics (last-mile per order, RUB) ----
function estimateFbsLogistics(weightL: number): number {
  if (weightL <= 0.1) return 35;
  if (weightL <= 0.25) return 48;
  if (weightL <= 0.5) return 63;
  if (weightL <= 1) return 95;
  if (weightL <= 2) return 135;
  if (weightL <= 3) return 165;
  if (weightL <= 5) return 220;
  return 330;
}

// ---- First-mile (China → Ozon warehouse Russia, RUB per kg) ----
function estimateFirstMile(weightKg: number, method: "air" | "sea" | "train" = "air"): number {
  const rates = { air: 165, sea: 55, train: 85 };
  // Air: ~165 RUB/kg (express 7-10 days), Sea: ~55 RUB/kg (30-45 days)
  return Math.max(weightKg * rates[method], Math.round(rates[method] * 0.5));
}

// ---- Ozon FBO handling fee (per unit, RUB) ----
function estimateHandlingFee(weightKg: number): number {
  if (weightKg <= 0.1) return 15;
  if (weightKg <= 0.5) return 25;
  if (weightKg <= 1) return 35;
  if (weightKg <= 3) return 50;
  return 75;
}

// ---- Last-mile delivery (RUB, Ozon to customer) ----
function estimateLastMile(weightKg: number): number {
  if (weightKg <= 0.5) return 55;
  if (weightKg <= 1) return 75;
  if (weightKg <= 2) return 100;
  if (weightKg <= 5) return 150;
  return 200;
}

// ---- Main calculation ----

interface ProfitInput {
  purchaseCostCny: number;
  sellingPriceRub: number;
  weightKg: number;
  category?: string;
  logisticsType?: "fbo" | "fbs";
  shippingMethod?: "air" | "sea" | "train";
  exchangeRate?: number;
  adCostRub?: number;
  packagingCostRub?: number;
  quantity?: number;
}

interface ProfitResult {
  inputs: {
    purchaseCostCny: number; sellingPriceRub: number; weightKg: number;
    exchangeRate: number; quantity: number;
  };
  costs: {
    purchaseCostRub: number; unitPurchaseRub: number;
    commissionRub: number; commissionRate: number;
    logisticsRub: number; handlingFeeRub: number; lastMileRub: number;
    logisticsType: string;
    firstMileRub: number; shippingMethod: string;
    packagingRub: number; adCostRub: number;
    withdrawalFeeRub: number; returnLossRub: number;
    totalCostRub: number;
  };
  profit: {
    revenueRub: number;
    grossProfitRub: number;
    netProfitRub: number;
    netProfitCny: number;
    marginPercent: number;
    roiPercent: number;
    breakEvenPrice: number;
    breakEvenVolume: number;
  };
  tieredAnalysis: Array<{
    price: number; margin: number; profit: number; volume10: number; volume50: number; volume100: number;
  }>;
}

export function calculateProfit(input: ProfitInput): ProfitResult {
  const {
    purchaseCostCny, sellingPriceRub, weightKg, category = "default",
    logisticsType = "fbo", shippingMethod = "air",
    exchangeRate = 11.5, adCostRub = 0, packagingCostRub = 30, quantity = 1,
  } = input;

  // Commission rate
  const commissionRate = COMMISSION_RATES[category] ?? COMMISSION_RATES["default"];
  const commissionRub = Math.round((sellingPriceRub * commissionRate) / 100 * 100) / 100;

  // Logistics (FBO: warehouse handling + last-mile. FBS: self-ship to customer)
  const handlingFeeRub = logisticsType === "fbo" ? estimateHandlingFee(weightKg) : 0;
  const lastMileRub = logisticsType === "fbo" ? estimateLastMile(weightKg) : 0;
  const logisticsRub = logisticsType === "fbs"
    ? estimateFbsLogistics(weightKg)
    : estimateFboLogistics(weightKg);

  // First mile (China → Russia)
  const firstMileRub = Math.round(estimateFirstMile(weightKg, shippingMethod) * 100) / 100;

  // Other fees
  const purchaseCostRub = Math.round(purchaseCostCny * exchangeRate * 100) / 100;
  const unitPurchaseRub = Math.round((purchaseCostRub / quantity) * 100) / 100;
  const withdrawalFeeRub = Math.round(sellingPriceRub * 0.015); // ~1.5% 提现
  const returnLossRub = Math.round(sellingPriceRub * 0.02);   // ~2% 退货损耗

  // Total per-unit cost
  const totalCostRub = Math.round(
    (unitPurchaseRub + commissionRub + logisticsRub + handlingFeeRub + lastMileRub +
     firstMileRub + packagingCostRub + adCostRub + withdrawalFeeRub + returnLossRub) * 100
  ) / 100;

  // Profit
  const revenueRub = sellingPriceRub;
  const grossProfitRub = Math.round((revenueRub - purchaseCostRub / quantity) * 100) / 100;
  const netProfitRub = Math.round((revenueRub - totalCostRub) * 100) / 100;
  const netProfitCny = Math.round((netProfitRub / exchangeRate) * 100) / 100;
  const marginPercent = Math.round((netProfitRub / revenueRub) * 10000) / 100;
  const roiPercent = Math.round(((netProfitRub / totalCostRub) * 100) * 100) / 100;

  // Break-even
  const breakEvenPrice = totalCostRub;
  const breakEvenVolume = netProfitRub > 0 ? 1 : Math.ceil(Math.abs(totalCostRub / netProfitRub));

  // Tiered pricing analysis
  const tieredAnalysis = [
    { price: Math.round(sellingPriceRub * 0.8), margin: 0, profit: 0, volume10: 0, volume50: 0, volume100: 0 },
    { price: Math.round(sellingPriceRub * 0.9), margin: 0, profit: 0, volume10: 0, volume50: 0, volume100: 0 },
    { price: sellingPriceRub, margin: 0, profit: 0, volume10: 0, volume50: 0, volume100: 0 },
    { price: Math.round(sellingPriceRub * 1.1), margin: 0, profit: 0, volume10: 0, volume50: 0, volume100: 0 },
    { price: Math.round(sellingPriceRub * 1.2), margin: 0, profit: 0, volume10: 0, volume50: 0, volume100: 0 },
  ].map(t => {
    const costs = purchaseCostRub / quantity + commissionRub * (t.price / sellingPriceRub) + logisticsRub + firstMileRub + packagingCostRub + withdrawalFeeRub * (t.price / sellingPriceRub) + returnLossRub * (t.price / sellingPriceRub);
    const profit = Math.round((t.price - costs) * 100) / 100;
    return {
      price: t.price,
      margin: Math.round((profit / t.price) * 10000) / 100,
      profit,
      volume10: Math.round(profit * 10 * 100) / 100,
      volume50: Math.round(profit * 50 * 100) / 100,
      volume100: Math.round(profit * 100 * 100) / 100,
    };
  });

  return {
    inputs: { purchaseCostCny, sellingPriceRub, weightKg, exchangeRate, quantity },
    costs: {
      purchaseCostRub,
      unitPurchaseRub,
      commissionRub, commissionRate,
      logisticsRub,
      handlingFeeRub,
      lastMileRub,
      logisticsType,
      firstMileRub, shippingMethod,
      packagingRub: packagingCostRub,
      adCostRub,
      withdrawalFeeRub,
      returnLossRub,
      totalCostRub,
    },
    profit: {
      revenueRub, grossProfitRub, netProfitRub, netProfitCny,
      marginPercent, roiPercent, breakEvenPrice, breakEvenVolume,
    },
    tieredAnalysis,
  };
}

// ---- Routes ----

export function createProfitCalcRouter(): Router {
  const router = Router();

  router.post("/profit/calc", (req, res) => {
    try {
      const input = req.body as ProfitInput;
      if (!input.purchaseCostCny || !input.sellingPriceRub || !input.weightKg) {
        return res.status(400).json({
          success: false,
          error: { code: "MISSING", message: "purchaseCostCny, sellingPriceRub, weightKg are required" },
          correlationId: req.correlationId,
        });
      }

      const result = calculateProfit(input);
      res.json({ success: true, data: result, correlationId: req.correlationId });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: "CALC_ERROR", message: (err as Error).message },
        correlationId: req.correlationId,
      });
    }
  });

  router.get("/profit/categories", (_req, res) => {
    res.json({ success: true, data: COMMISSION_RATES, correlationId: _req.correlationId });
  });

  return router;
}
