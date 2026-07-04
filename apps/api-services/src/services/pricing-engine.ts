import type { CompetitorInfo, ProductAnalysis } from "./product-analyzer.js";
import { calculateProfit } from "./profit-calc.js";

export interface PricingOptions {
  minMargin: number;
  maxMargin: number;
  desiredPosition: 'leader' | 'middle' | 'premium';
  useDynamicPricing: boolean;
  discountEnabled: boolean;
  minDiscount: number;
  maxDiscount: number;
  weightKg: number;
}

export interface PricingResult {
  basePriceRub: number;
  finalPriceRub: number;
  margin: number;
  totalCostRub: number;
  suggestedDiscount: number;
  pricePosition: 'below_avg' | 'at_avg' | 'above_avg';
  competitorPriceRange: { min: number; max: number; avg: number };
  strategy: string;
  isFeasible: boolean;
  feasibilityNote: string;
}

export class PricingEngine {
  private defaultOptions: PricingOptions = {
    minMargin: 0.15,
    maxMargin: 0.6,
    desiredPosition: 'middle',
    useDynamicPricing: true,
    discountEnabled: true,
    minDiscount: 0,
    maxDiscount: 0.15,
    weightKg: 0.3
  };

  calculatePrice(
    costCny: number,
    exchangeRate: number,
    competitors: CompetitorInfo[],
    options?: Partial<PricingOptions>
  ): PricingResult {
    const opts: PricingOptions = { ...this.defaultOptions, ...options };
    
    const profitInfo = calculateProfit({
      costCny,
      sellingPriceRub: 0,
      exchangeRate,
      weightKg: opts.weightKg
    });
    
    const totalCostRub = profitInfo.totalCostRub;
    
    const minPriceForMargin = Math.round(totalCostRub / (1 - opts.minMargin));
    const maxPriceForMargin = Math.round(totalCostRub / (1 - opts.maxMargin));
    
    const minPriceRub = Math.max(1, Math.min(minPriceForMargin, maxPriceForMargin));
    const maxPriceRub = Math.max(1, Math.max(minPriceForMargin, maxPriceForMargin));

    const priceRange = this.getCompetitorPriceRange(competitors);
    
    let targetPriceRub: number;
    let strategy: string;
    let pricePosition: 'below_avg' | 'at_avg' | 'above_avg';
    let isFeasible = true;
    let feasibilityNote = '';

    if (competitors.length === 0) {
      targetPriceRub = Math.round(totalCostRub * 1.5);
      strategy = '无竞品参考，使用成本加成定价(1.5倍)';
      pricePosition = 'at_avg';
    } else {
      if (priceRange.avg < minPriceRub) {
        isFeasible = false;
        feasibilityNote = `竞品平均价格(₽${priceRange.avg})低于最低成本价(₽${minPriceRub})，按此价格销售会亏损`;
        targetPriceRub = minPriceRub;
        strategy = '⚠️ 价格警告：竞品价格低于成本线，建议重新评估选品';
        pricePosition = 'above_avg';
      } else {
        const { target, position, strat } = this.determineTargetPrice(
          priceRange,
          minPriceRub,
          maxPriceRub,
          totalCostRub,
          opts.desiredPosition,
          opts.useDynamicPricing
        );
        targetPriceRub = target;
        pricePosition = position;
        strategy = strat;
      }
    }

    const finalMargin = 1 - (totalCostRub / targetPriceRub);
    const suggestedDiscount = this.calculateDiscount(competitors, priceRange, finalMargin, opts);
    
    const finalPriceRub = Math.round(targetPriceRub * (1 - suggestedDiscount));

    return {
      basePriceRub: targetPriceRub,
      finalPriceRub,
      margin: finalMargin,
      totalCostRub,
      suggestedDiscount,
      pricePosition,
      competitorPriceRange: priceRange,
      strategy,
      isFeasible,
      feasibilityNote
    };
  }

  private getCompetitorPriceRange(competitors: CompetitorInfo[]): { min: number; max: number; avg: number } {
    if (competitors.length === 0) {
      return { min: 0, max: 0, avg: 0 };
    }
    
    const prices = competitors.map(c => c.priceRub).filter(p => p > 0);
    if (prices.length === 0) {
      return { min: 0, max: 0, avg: 0 };
    }
    
    return {
      min: Math.min(...prices),
      max: Math.max(...prices),
      avg: Math.round(prices.reduce((sum, p) => sum + p, 0) / prices.length)
    };
  }

  private determineTargetPrice(
    priceRange: { min: number; max: number; avg: number },
    minPriceRub: number,
    maxPriceRub: number,
    totalCostRub: number,
    desiredPosition: 'leader' | 'middle' | 'premium',
    useDynamic: boolean
  ): { target: number; position: 'below_avg' | 'at_avg' | 'above_avg'; strat: string } {
    let target: number;
    let position: 'below_avg' | 'at_avg' | 'above_avg';
    let strat: string;

    const avgCompetitorPrice = priceRange.avg;

    if (!useDynamic) {
      target = Math.round(totalCostRub * 1.5);
      position = 'at_avg';
      strat = '固定定价策略 - 成本1.5倍加成';
    } else {
      switch (desiredPosition) {
        case 'leader': {
          const leaderTarget = Math.round(avgCompetitorPrice * 0.9);
          target = Math.max(minPriceRub, leaderTarget);
          position = target < avgCompetitorPrice * 0.95 ? 'below_avg' : 'at_avg';
          strat = target === minPriceRub 
            ? `🏆 价格领先策略 - 但受最低利润限制，定价₽${target}(略高竞品)`
            : `🏆 价格领先策略 - 低于市场平均10%，定价₽${target}`;
          break;
        }
        case 'premium': {
          const premiumTarget = Math.round(avgCompetitorPrice * 1.15);
          target = Math.min(maxPriceRub, premiumTarget);
          position = target > avgCompetitorPrice * 1.05 ? 'above_avg' : 'at_avg';
          strat = target === maxPriceRub
            ? `💎 溢价策略 - 但受最高利润限制，定价₽${target}(接近市场平均)`
            : `💎 溢价策略 - 高于市场平均15%，定价₽${target}，适合有差异化的商品`;
          break;
        }
        default: {
          const middleTarget = avgCompetitorPrice;
          target = Math.max(minPriceRub, Math.min(maxPriceRub, middleTarget));
          if (target < avgCompetitorPrice * 0.95) {
            position = 'below_avg';
          } else if (target > avgCompetitorPrice * 1.05) {
            position = 'above_avg';
          } else {
            position = 'at_avg';
          }
          strat = target === avgCompetitorPrice
            ? `📊 市场跟随策略 - 与市场平均价格一致，定价₽${target}`
            : `📊 市场跟随策略 - 受利润限制，定价₽${target}(${target > avgCompetitorPrice ? '略高于' : '略低于'}市场平均)`;
        }
      }
    }

    return { target, position, strat };
  }

  private calculateDiscount(
    competitors: CompetitorInfo[],
    priceRange: { avg: number },
    currentMargin: number,
    opts: PricingOptions
  ): number {
    if (!opts.discountEnabled || competitors.length === 0) {
      return 0;
    }

    const avgRating = competitors.reduce((sum, c) => sum + c.rating, 0) / competitors.length;
    const highRatingCompetitors = competitors.filter(c => c.rating >= 4.5);
    
    if (avgRating >= 4.5 && highRatingCompetitors.length > competitors.length * 0.5) {
      if (currentMargin > opts.minMargin + 0.1) {
        return opts.minDiscount + Math.random() * (opts.maxDiscount - opts.minDiscount);
      }
    }

    return 0;
  }

  calculateBatchPrices(
    products: Array<{ costCny: number; competitors: CompetitorInfo[]; weightKg?: number }>,
    exchangeRate: number,
    options?: Partial<PricingOptions>
  ): PricingResult[] {
    return products.map(p => 
      this.calculatePrice(p.costCny, exchangeRate, p.competitors, { ...options, weightKg: p.weightKg })
    );
  }

  suggestPriceAdjustment(
    currentPriceRub: number,
    costCny: number,
    exchangeRate: number,
    competitors: CompetitorInfo[],
    salesData?: { recentSales: number; targetSales: number }
  ): { adjustToPriceRub: number; adjustment: number; reason: string } {
    const newPrice = this.calculatePrice(costCny, exchangeRate, competitors);
    const adjustment = ((newPrice.finalPriceRub - currentPriceRub) / currentPriceRub) * 100;
    
    let reason = '';
    
    if (salesData) {
      const salesGap = salesData.targetSales - salesData.recentSales;
      if (salesGap > 0 && adjustment < 0) {
        reason = `销量低于目标(${salesData.recentSales}/${salesData.targetSales})，建议降价${Math.abs(adjustment).toFixed(1)}%`;
      } else if (salesGap < 0 && adjustment > 0) {
        reason = `销量高于目标(${salesData.recentSales}/${salesData.targetSales})，建议提价${adjustment.toFixed(1)}%`;
      } else {
        reason = '市场价格变动，建议调整价格';
      }
    } else {
      reason = '根据市场情况建议调整价格';
    }

    return {
      adjustToPriceRub: newPrice.finalPriceRub,
      adjustment,
      reason
    };
  }
}