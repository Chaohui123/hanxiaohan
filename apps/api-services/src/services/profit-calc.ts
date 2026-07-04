export interface ProfitCalculationInput {
  costCny: number;
  sellingPriceRub: number;
  exchangeRate: number;
  weightKg: number;
  shippingCostCny?: number;
  platformFeePercent?: number;
  packagingCostCny?: number;
  otherCostsCny?: number;
}

export interface ProfitCalculationResult {
  costCny: number;
  sellingPriceRub: number;
  exchangeRate: number;
  totalCostCny: number;
  totalCostRub: number;
  grossProfitRub: number;
  marginPercent: number;
  landedCostRub: number;
  breakdown: {
    productCost: number;
    shippingCost: number;
    packagingCost: number;
    platformFee: number;
    otherCosts: number;
  };
}

export function calculateProfit(input: ProfitCalculationInput): ProfitCalculationResult {
  const {
    costCny,
    sellingPriceRub,
    exchangeRate,
    weightKg,
    shippingCostCny = calculateShippingCost(weightKg, costCny),
    platformFeePercent = 0.15,
    packagingCostCny = calculatePackagingCost(weightKg),
    otherCostsCny = 0
  } = input;

  const platformFeeRub = sellingPriceRub * platformFeePercent;
  
  const totalCostCny = costCny + shippingCostCny + packagingCostCny + otherCostsCny;
  const totalCostRub = totalCostCny * exchangeRate + platformFeeRub;
  
  const grossProfitRub = sellingPriceRub - totalCostRub;
  const marginPercent = sellingPriceRub > 0 
    ? (grossProfitRub / sellingPriceRub) * 100 
    : 0;

  return {
    costCny,
    sellingPriceRub,
    exchangeRate,
    totalCostCny: Math.round(totalCostCny * 100) / 100,
    totalCostRub: Math.round(totalCostRub),
    grossProfitRub: Math.round(grossProfitRub),
    marginPercent: Math.round(marginPercent * 10) / 10,
    landedCostRub: Math.round((costCny + shippingCostCny) * exchangeRate),
    breakdown: {
      productCost: Math.round(costCny * exchangeRate),
      shippingCost: Math.round(shippingCostCny * exchangeRate),
      packagingCost: Math.round(packagingCostCny * exchangeRate),
      platformFee: Math.round(platformFeeRub),
      otherCosts: Math.round(otherCostsCny * exchangeRate)
    }
  };
}

function calculateShippingCost(weightKg: number, productCostCny: number): number {
  const baseRatePerKg = 80;
  const minShippingCost = 5;
  const maxShippingRatio = 0.5;
  
  let weightBasedCost = weightKg * baseRatePerKg;
  
  if (weightKg <= 0.1) {
    weightBasedCost = 5;
  } else if (weightKg <= 0.3) {
    weightBasedCost = 8;
  } else if (weightKg <= 0.5) {
    weightBasedCost = 12;
  } else if (weightKg <= 1) {
    weightBasedCost = 18;
  } else if (weightKg <= 2) {
    weightBasedCost = 30;
  } else if (weightKg <= 3) {
    weightBasedCost = 45;
  } else if (weightKg <= 5) {
    weightBasedCost = 70;
  } else {
    weightBasedCost = weightKg * 18;
  }
  
  const costBasedMax = productCostCny * maxShippingRatio;
  const finalShippingCost = Math.max(minShippingCost, Math.min(weightBasedCost, costBasedMax));
  
  return Math.round(finalShippingCost * 100) / 100;
}

function calculatePackagingCost(weightKg: number): number {
  if (weightKg <= 0.1) return 0.5;
  if (weightKg <= 0.3) return 1;
  if (weightKg <= 0.5) return 1.5;
  if (weightKg <= 1) return 2;
  if (weightKg <= 2) return 3;
  return 5;
}

export function calculateSuggestedPrice(
  costCny: number,
  exchangeRate: number,
  targetMargin: number = 0.3,
  weightKg: number = 0.5
): number {
  const shippingCostCny = calculateShippingCost(weightKg, costCny);
  const packagingCostCny = calculatePackagingCost(weightKg);
  const platformFeePercent = 0.15;
  
  const totalVariableCostCny = costCny + shippingCostCny + packagingCostCny;
  const totalVariableCostRub = totalVariableCostCny * exchangeRate;
  
  const denominator = 1 - targetMargin - platformFeePercent;
  if (denominator <= 0) {
    return Math.round(totalVariableCostRub * 1.5);
  }
  
  const sellingPriceRub = totalVariableCostRub / denominator;
  
  return Math.round(sellingPriceRub);
}

export function compareSuppliers(
  suppliers: Array<{
    name: string;
    unitCostCny: number;
    minOrderQuantity: number;
    leadTimeDays: number;
    reliability: number;
  }>,
  quantity: number,
  exchangeRate: number
): Array<{
  name: string;
  totalCostRub: number;
  unitCostRub: number;
  leadTimeDays: number;
  reliability: number;
  score: number;
}> {
  return suppliers.map(supplier => {
    const actualQty = Math.max(quantity, supplier.minOrderQuantity);
    const totalCostCny = actualQty * supplier.unitCostCny;
    const totalCostRub = totalCostCny * exchangeRate;
    const unitCostRub = totalCostRub / actualQty;
    
    const costScore = 1 - (unitCostRub / 1000);
    const leadTimeScore = 1 - (supplier.leadTimeDays / 30);
    const reliabilityScore = supplier.reliability;
    
    const score = (costScore * 0.4 + leadTimeScore * 0.3 + reliabilityScore * 0.3);
    
    return {
      name: supplier.name,
      totalCostRub: Math.round(totalCostRub),
      unitCostRub: Math.round(unitCostRub),
      leadTimeDays: supplier.leadTimeDays,
      reliability: supplier.reliability,
      score: Math.round(score * 100) / 100
    };
  }).sort((a, b) => b.score - a.score);
}