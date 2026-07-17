import type { ScrapedProduct } from "@onzo/shared-types";
import { calculateProfit } from "./profit-calc.js";
import { analyzeProductForRussia, getComplianceSummary, type MarketAnalysis } from "./russia-market-rules.js";

export type CompetitionLevel = 'low' | 'medium' | 'high';
export type TrendDirection = 'up' | 'stable' | 'down';

export interface CompetitorInfo {
  productId: number;
  priceRub: number;
  rating: number;
  reviewCount: number;
  salesVolume: number;
  title: string;
}

export interface ProductAnalysis {
  sourceUrl: string;
  title: string;
  category: string;
  priceCny: number;
  estimatedPriceRub: number;
  profitMargin: number;
  totalCostRub: number;
  competitionLevel: CompetitionLevel;
  salesVolume: number;
  trend: TrendDirection;
  suggested: boolean;
  competitors: CompetitorInfo[];
  recommendation: string;
  score: number;
  feasibilityNote?: string;
  russiaMarket: MarketAnalysis;
  overallScore: number;
  finalVerdict: 'recommend' | 'consider' | 'caution' | 'reject';
}

export interface AnalysisOptions {
  minProfitMargin: number;
  maxCompetitionLevel: CompetitionLevel;
  minSalesVolume: number;
  exchangeRate: number;
  weightKg: number;
  checkCompliance: boolean;
  checkLogistics: boolean;
  checkMarketDemand: boolean;
}

export class ProductAnalyzer {
  private defaultOptions: AnalysisOptions = {
    minProfitMargin: 0.2,
    maxCompetitionLevel: 'high',
    minSalesVolume: 10,
    exchangeRate: 12.5,
    weightKg: 0.3,
    checkCompliance: true,
    checkLogistics: true,
    checkMarketDemand: true
  };

  analyzeProduct(
    scraped: ScrapedProduct,
    competitors: CompetitorInfo[],
    options?: Partial<AnalysisOptions>
  ): ProductAnalysis {
    const opts: AnalysisOptions = { ...this.defaultOptions, ...options };

    const priceCny = scraped.price.currentMin;
    const profitInfo = calculateProfit({
      costCny: priceCny,
      sellingPriceRub: 0,
      exchangeRate: opts.exchangeRate,
      weightKg: opts.weightKg
    });
    
    const totalCostRub = profitInfo.totalCostRub;
    const competitorAvgPrice = competitors.length > 0
      ? Math.round(competitors.reduce((sum, c) => sum + c.priceRub, 0) / competitors.length)
      : Math.round(totalCostRub * 1.5);
    
    const targetPriceRub = Math.max(
      Math.round(totalCostRub / (1 - opts.minProfitMargin)),
      competitorAvgPrice
    );
    
    const actualProfitMargin = 1 - (totalCostRub / targetPriceRub);
    const competition = this.analyzeCompetition(competitors);
    const trend = this.analyzeTrend(competitors);
    const salesVolume = this.estimateSalesVolume(competitors);
    
    const isFeasible = targetPriceRub > totalCostRub;
    const meetsCriteria = isFeasible && this.meetsSelectionCriteria(
      actualProfitMargin,
      competition,
      salesVolume,
      opts
    );
    
    const score = this.calculateScore(
      actualProfitMargin,
      competition,
      salesVolume,
      trend
    );

    let russiaMarket: MarketAnalysis;
    if (opts.checkCompliance || opts.checkLogistics || opts.checkMarketDemand) {
      russiaMarket = analyzeProductForRussia(
        scraped.title,
        (scraped as unknown as Record<string, string>).description || '',
        scraped.categoryPath,
        opts.weightKg
      );
    } else {
      russiaMarket = {
        isForbidden: false,
        isRestricted: false,
        isLogisticsRisk: false,
        isHighDemand: false,
        demandLevel: 'none',
        complianceScore: 100,
        logisticsScore: 100,
        marketScore: 50,
        overallScore: 80,
        warnings: [],
        recommendations: [],
        riskTags: []
      };
    }

    let finalVerdict: ProductAnalysis['finalVerdict'];
    let overallScore: number;

    if (russiaMarket.isForbidden) {
      finalVerdict = 'reject';
      overallScore = 0;
    } else {
      overallScore = Math.round(
        (score * 0.35) +
        (russiaMarket.complianceScore * 0.3) +
        (russiaMarket.logisticsScore * 0.2) +
        (russiaMarket.marketScore * 0.15)
      );

      if (overallScore >= 80 && meetsCriteria) {
        finalVerdict = 'recommend';
      } else if (overallScore >= 60 && meetsCriteria) {
        finalVerdict = 'consider';
      } else if (russiaMarket.isRestricted || russiaMarket.isLogisticsRisk) {
        finalVerdict = 'caution';
      } else {
        finalVerdict = 'reject';
      }
    }

    const finalRecommended = finalVerdict === 'recommend' || finalVerdict === 'consider';

    return {
      sourceUrl: scraped.sourceUrl,
      title: scraped.title,
      category: scraped.categoryPath.join(' > '),
      priceCny,
      estimatedPriceRub: targetPriceRub,
      profitMargin: actualProfitMargin,
      totalCostRub,
      competitionLevel: competition,
      salesVolume,
      trend,
      suggested: finalRecommended,
      competitors,
      recommendation: this.generateRecommendation(
        finalRecommended,
        isFeasible,
        actualProfitMargin,
        competition,
        salesVolume,
        targetPriceRub,
        competitorAvgPrice,
        totalCostRub,
        russiaMarket,
        finalVerdict
      ),
      score,
      feasibilityNote: !isFeasible 
        ? `成本₽${totalCostRub} > 竞品均价₽${competitorAvgPrice}，无利润空间`
        : undefined,
      russiaMarket,
      overallScore,
      finalVerdict
    };
  }

  private analyzeCompetition(competitors: CompetitorInfo[]): CompetitionLevel {
    if (competitors.length === 0) return 'low';
    if (competitors.length <= 5) return 'low';
    if (competitors.length <= 15) return 'medium';
    return 'high';
  }

  private analyzeTrend(competitors: CompetitorInfo[]): TrendDirection {
    if (competitors.length < 3) return 'stable';
    
    const avgRating = competitors.reduce((sum, c) => sum + c.rating, 0) / competitors.length;
    const activeListings = competitors.filter(c => c.reviewCount > 10).length;
    
    if (avgRating >= 4.5 && activeListings > competitors.length * 0.7) {
      return 'up';
    }
    if (avgRating < 3.5 || activeListings < competitors.length * 0.3) {
      return 'down';
    }
    return 'stable';
  }

  private estimateSalesVolume(competitors: CompetitorInfo[]): number {
    if (competitors.length === 0) return 10;
    
    const activeCompetitors = competitors.filter(c => c.reviewCount > 5);
    if (activeCompetitors.length === 0) return 10;
    
    const avgReviews = activeCompetitors.reduce((sum, c) => sum + c.reviewCount, 0) / activeCompetitors.length;
    return Math.round(avgReviews * 2);
  }

  private meetsSelectionCriteria(
    profitMargin: number,
    competition: CompetitionLevel,
    salesVolume: number,
    opts: AnalysisOptions
  ): boolean {
    const competitionLevels: Record<CompetitionLevel, number> = { low: 1, medium: 2, high: 3 };
    const meetsCompetition = competitionLevels[competition] <= competitionLevels[opts.maxCompetitionLevel];

    return profitMargin >= opts.minProfitMargin && 
           meetsCompetition && 
           salesVolume >= opts.minSalesVolume;
  }

  private generateRecommendation(
    meetsCriteria: boolean,
    isFeasible: boolean,
    profitMargin: number,
    competition: CompetitionLevel,
    salesVolume: number,
    targetPrice: number,
    competitorAvgPrice: number,
    totalCostRub: number,
    russiaMarket: MarketAnalysis,
    finalVerdict: ProductAnalysis['finalVerdict']
  ): string {
    const parts: string[] = [];

    if (russiaMarket.isForbidden) {
      parts.push('🚫 俄罗斯市场禁止销售此商品');
      russiaMarket.warnings.slice(0, 2).forEach(w => parts.push(`   ${w}`));
      return parts.join('\n');
    }

    const verdictMap = {
      'recommend': '✅ 强烈推荐上架俄罗斯市场',
      'consider': '🟢 可以考虑上架',
      'caution': '⚠️ 谨慎上架，有风险因素',
      'reject': '❌ 不建议上架'
    };

    parts.push(verdictMap[finalVerdict]);

    if (!isFeasible) {
      parts.push(`💰 成本₽${totalCostRub} 超过 竞品均价₽${competitorAvgPrice}，需要找更便宜的货源`);
    } else {
      parts.push(`💰 参考售价 ₽${targetPrice}，毛利率 ${(profitMargin * 100).toFixed(1)}%`);
    }

    if (profitMargin >= 0.4) {
      parts.push('   📈 高利润率，盈利空间大');
    } else if (profitMargin >= 0.2) {
      parts.push('   📊 利润率合理');
    } else if (profitMargin > 0) {
      parts.push('   ⚠️ 利润率偏低，需要优化成本');
    }

    if (russiaMarket.riskTags.length > 0) {
      parts.push(`   🔖 风险标签: ${russiaMarket.riskTags.slice(0, 3).join(', ')}`);
    }

    if (russiaMarket.isHighDemand) {
      parts.push('   🌟 符合俄罗斯市场热门需求品类');
    }

    if (russiaMarket.isLogisticsRisk) {
      parts.push('   📦 需要注意物流包装和运输方式');
    }

    russiaMarket.recommendations.slice(0, 2).forEach(r => parts.push(`   ${r}`));

    const scoreParts: string[] = [];
    scoreParts.push(`商业评分: ${Math.round(
      (profitMargin * 100 + salesVolume / 2 + (competition === 'low' ? 30 : competition === 'medium' ? 20 : 10))
    )}`);
    scoreParts.push(`合规: ${russiaMarket.complianceScore}`);
    scoreParts.push(`物流: ${russiaMarket.logisticsScore}`);
    scoreParts.push(`市场: ${russiaMarket.marketScore}`);
    scoreParts.push(`综合: ${Math.round(
      (profitMargin * 100 * 0.35) +
      (russiaMarket.complianceScore * 0.3) +
      (russiaMarket.logisticsScore * 0.2) +
      (russiaMarket.marketScore * 0.15)
    )}`);
    parts.push(`   📊 ${scoreParts.join(' | ')}`);

    return parts.join('\n');
  }

  private calculateScore(
    profitMargin: number,
    competition: CompetitionLevel,
    salesVolume: number,
    trend: TrendDirection
  ): number {
    let score = 0;
    
    score += Math.min(profitMargin * 100, 50);
    
    const competitionScore = competition === 'low' ? 30 : 
                            competition === 'medium' ? 20 : 10;
    score += competitionScore;
    
    score += Math.min(salesVolume / 10, 20);
    
    if (trend === 'up') score += 10;
    else if (trend === 'stable') score += 5;
    
    return Math.round(score * 10) / 10;
  }

  batchAnalyze(
    products: ScrapedProduct[],
    competitorsMap: Map<string, CompetitorInfo[]>,
    options?: Partial<AnalysisOptions>
  ): ProductAnalysis[] {
    return products.map(product => {
      const competitors = competitorsMap.get(product.sourceUrl) || [];
      return this.analyzeProduct(product, competitors, options);
    }).sort((a, b) => b.overallScore - a.overallScore);
  }
}

export { getComplianceSummary };