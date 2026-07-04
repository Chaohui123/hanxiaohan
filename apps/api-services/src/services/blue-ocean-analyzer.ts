import { analyzeProductForRussia, getHighDemandCategoriesForCurrentSeason, getAutoPartCategoriesSorted, type AutoPartCategory, type CategoryDemandConfig } from './russia-market-rules.js';
import { calculateProfit } from './profit-calc.js';
import type { ScrapedProduct } from '@onzo/shared-types';

export interface BlueOceanScore {
  overall: number;
  marketDemand: number;
  profitPotential: number;
  competitionLevel: number;
  diyFriendliness: number;
  logisticsFriendliness: number;
  seasonality: number;
  repeatPurchase: number;
  brandRisk: number;
  complianceScore: number;
}

export interface BlueOceanAnalysis {
  product: ScrapedProduct;
  score: BlueOceanScore;
  overallScore: number;
  verdict: 'TOP' | 'HIGH' | 'GOOD' | 'MARGINAL' | 'LOW' | 'RISK' | 'REJECT';
  recommendedPriceRub: number;
  estimatedProfitPerUnit: number;
  strengths: string[];
  weaknesses: string[];
  actionItems: string[];
  categoryTags: string[];
  isAutoPart: boolean;
  isHighDemand: boolean;
  isLogisticsRisk: boolean;
  isForbidden: boolean;
  isSeasonal: boolean;
}

export interface OnzoSalesTrend {
  category: string;
  hotKeywords: string[];
  avgPriceRub: number;
  avgProfitMargin: number;
  salesGrowth: number;
  listingCount: number;
  recommendation: string;
}

const ONZO_HISTORICAL_TRENDS: OnzoSalesTrend[] = [
  { category: '汽车保养耗材', hotKeywords: ['机油', '滤清器', '雨刷', '玻璃水', '防冻液'], avgPriceRub: 800, avgProfitMargin: 0.45, salesGrowth: 25, listingCount: 1800, recommendation: '刚需高频，俄罗斯车主80%自行更换，低竞争高复购' },
  { category: '汽车内饰装饰', hotKeywords: ['脚垫', '座套', '方向盘套', '收纳盒', '手机支架'], avgPriceRub: 1500, avgProfitMargin: 0.5, salesGrowth: 30, listingCount: 2500, recommendation: '个性装饰需求强，款式多易差异化，物流简单' },
  { category: '汽车应急救援', hotKeywords: ['应急包', '搭电线', '拖车绳', '千斤顶', '安全锤', '灭火器', '三角警示牌'], avgPriceRub: 1200, avgProfitMargin: 0.55, salesGrowth: 40, listingCount: 1200, recommendation: '车主必备安全产品，刚需强，新品容易起量' },
  { category: '冬季保暖服装', hotKeywords: ['羽绒服', '棉衣', '保暖内衣', '冬装', '外套'], avgPriceRub: 3500, avgProfitMargin: 0.4, salesGrowth: 60, listingCount: 5000, recommendation: '冬季刚需，9-11月爆发期，注意提前备货' },
  { category: '冬季保暖用品', hotKeywords: ['手套', '帽子', '围巾', '暖宝宝', '保温杯', '电热毯'], avgPriceRub: 600, avgProfitMargin: 0.45, salesGrowth: 45, listingCount: 3000, recommendation: '冬季高复购产品，小体积高利润' },
  { category: '鞋靴', hotKeywords: ['雪地靴', '马丁靴', '运动鞋', '保暖鞋'], avgPriceRub: 2500, avgProfitMargin: 0.35, salesGrowth: 35, listingCount: 6000, recommendation: '冬季热销，注意尺码和库存深度' },
  { category: '家居收纳', hotKeywords: ['收纳盒', '收纳袋', '挂钩', '置物架', '衣架', '收纳箱'], avgPriceRub: 800, avgProfitMargin: 0.5, salesGrowth: 20, listingCount: 4000, recommendation: '刚需稳定，低物流成本，易批量' },
  { category: '清洁用品', hotKeywords: ['清洁布', '拖把', '海绵', '清洁剂', '清洁工具', '魔术擦'], avgPriceRub: 400, avgProfitMargin: 0.45, salesGrowth: 25, listingCount: 2000, recommendation: '高频消耗品，复购率高' },
  { category: '汽车清洁养护', hotKeywords: ['洗车液', '车蜡', '毛巾', '海绵', '拖把', '高压水枪', '吸尘器'], avgPriceRub: 700, avgProfitMargin: 0.5, salesGrowth: 30, listingCount: 1500, recommendation: 'DIY洗车文化盛行，高复购' },
  { category: '家庭维修工具', hotKeywords: ['螺丝刀', '扳手', '工具套装', '钳子', '锤子', '卷尺', '电钻'], avgPriceRub: 1500, avgProfitMargin: 0.55, salesGrowth: 28, listingCount: 2200, recommendation: '俄罗斯DIY文化浓厚，工具类高利润' },
  { category: 'LED照明', hotKeywords: ['LED灯泡', '灯带', '台灯', '小夜灯', '手电筒'], avgPriceRub: 500, avgProfitMargin: 0.4, salesGrowth: 22, listingCount: 3500, recommendation: '节能政策推动，稳定需求' },
  { category: '电子产品配件', hotKeywords: ['数据线', '充电器', '手机壳', '钢化膜', '耳机', '蓝牙', '鼠标', '键盘'], avgPriceRub: 600, avgProfitMargin: 0.4, salesGrowth: 18, listingCount: 8000, recommendation: '高竞争市场，需精细化选品，找小众款式' },
  { category: '厨房小家电配件', hotKeywords: ['电饭煲', '电热水壶', '空气炸锅', '料理机', '豆浆机'], avgPriceRub: 2000, avgProfitMargin: 0.35, salesGrowth: 15, listingCount: 2800, recommendation: '注意电压问题，俄罗斯220V标准' },
  { category: '五金维修耗材', hotKeywords: ['螺丝', '膨胀螺丝', '免钉胶', '密封胶', '胶带', '防水', '粘合剂'], avgPriceRub: 300, avgProfitMargin: 0.55, salesGrowth: 20, listingCount: 1500, recommendation: '高频维修耗材，超适合跨境，重量轻利润高' },
  { category: '水暖卫浴配件', hotKeywords: ['水龙头', '花洒', '接头', '角阀', '地漏', '密封圈', '生料带'], avgPriceRub: 450, avgProfitMargin: 0.5, salesGrowth: 18, listingCount: 1000, recommendation: '小体积高利润，DIY维修常用' }
];

export function analyzeForBlueOcean(
  scraped: ScrapedProduct,
  competitors: { priceRub: number; salesVolume?: number }[] = [],
  options?: {
    exchangeRate?: number;
    weightKg?: number;
    costCny?: number;
    targetMargin?: number;
  }
): BlueOceanAnalysis {
  const opts = { exchangeRate: 12.5, weightKg: 0.3, costCny: scraped.price.currentMin, targetMargin: 0.35, ...options };
  
  const title = scraped.title;
  const description = scraped.description || '';
  const content = `${title} ${description}`.toLowerCase();

  const russiaAnalysis = analyzeProductForRussia(title, description, scraped.categoryPath, opts.weightKg);

  const profitInfo = calculateProfit({
    costCny: opts.costCny,
    sellingPriceRub: 0,
    exchangeRate: opts.exchangeRate,
    weightKg: opts.weightKg
  });

  const avgCompetitorPrice = competitors.length > 0
    ? competitors.reduce((sum, c) => sum + c.priceRub, 0) / competitors.length
    : profitInfo.totalCostRub / (1 - opts.targetMargin);

  const targetPrice = Math.max(
    Math.round(profitInfo.totalCostRub / (1 - opts.targetMargin)),
    Math.round(avgCompetitorPrice * 0.95)
  );

  const estimatedProfitPerUnit = targetPrice - profitInfo.totalCostRub;
  const actualMargin = profitInfo.totalCostRub > 0 ? (estimatedProfitPerUnit / targetPrice) : 0;

  const currentMonth = new Date().getMonth() + 1;
  let seasonalMatchScore = 50;
  if (russiaAnalysis.isHighDemand) {
    seasonalMatchScore = 80;
    const isWinterItem = ['羽绒', '棉衣', '保暖', '冬装', '雪地', '帽子', '手套', '围巾', '防滑', '防冻液', '玻璃水', '雪地靴'].some(k => content.includes(k));
    const isSummerItem = ['夏季', '短袖', '冰丝', '风扇', '空调', '防晒', '游泳', '户外帐篷'].some(k => content.includes(k));
    
    if ((currentMonth >= 9 || currentMonth <= 2) && isWinterItem) {
      seasonalMatchScore = 100;
    } else if (currentMonth >= 5 && currentMonth <= 8 && isSummerItem) {
      seasonalMatchScore = 95;
    } else if (russiaAnalysis.seasonalInfo?.seasonalScore) {
      seasonalMatchScore = russiaAnalysis.seasonalInfo.seasonalScore;
    }
  }

  let repeatPurchaseScore = 50;
  const repeatKeywords = ['清洁布', '海绵', '玻璃水', '机油', '滤芯', '滤清器', '雨刷', '刹车片', '火花塞', '灯泡', '清洁', '毛巾', '牙刷', '耗材', '替换', '纸巾', '垃圾袋', '胶带', '胶', '清洁剂', '洗衣', '洗碗', '润滑', '除锈'];
  if (repeatKeywords.some(k => content.includes(k))) {
    repeatPurchaseScore = 90;
  } else if (['收纳', '工具', '配件', '装饰', '支架', '盒', '袋', '挂钩'].some(k => content.includes(k))) {
    repeatPurchaseScore = 65;
  } else if (['服装', '鞋', '靴', '外套', '羽绒服'].some(k => content.includes(k))) {
    repeatPurchaseScore = 55;
  }

  const competitionLevel = competitors.length === 0 ? 90 :
    competitors.length <= 5 ? 80 :
    competitors.length <= 15 ? 65 :
    competitors.length <= 30 ? 45 : 30;

  const profitPotential = actualMargin >= 0.5 ? 100 :
    actualMargin >= 0.4 ? 90 :
    actualMargin >= 0.3 ? 75 :
    actualMargin >= 0.2 ? 55 : 30;

  let diyFriendlinessScore = 50;
  if (russiaAnalysis.autoPartAnalysis?.isAutoPart) {
    diyFriendlinessScore = russiaAnalysis.autoPartAnalysis.diyFriendliness;
  } else if (['工具', '维修', '螺丝', '胶', '配件', '更换', 'DIY', '自己', '简单', '免工具'].some(k => content.includes(k))) {
    diyFriendlinessScore = 80;
  }

  const logisticsFriendlinessScore = russiaAnalysis.logisticsScore;
  const marketDemandScore = russiaAnalysis.marketScore;
  const complianceScore = russiaAnalysis.complianceScore;

  let brandRiskScore = 80;
  if (['耐克', 'nike', '阿迪', 'adidas', '苹果', 'iphone', 'lv', 'gucci', '仿品', '同款', '复刻', '小米', 'mi', 'huawei', '华为'].some(k => content.includes(k.toLowerCase()))) {
    brandRiskScore = 20;
  } else if (['品牌', '正品', '授权'].some(k => content.includes(k))) {
    brandRiskScore = 60;
  }

  const overallScore = Math.round(
    marketDemandScore * 0.20 +
    profitPotential * 0.20 +
    competitionLevel * 0.15 +
    diyFriendlinessScore * 0.12 +
    logisticsFriendlinessScore * 0.10 +
    seasonalMatchScore * 0.08 +
    repeatPurchaseScore * 0.10 +
    brandRiskScore * 0.05
  );

  let verdict: BlueOceanAnalysis['verdict'];
  if (russiaAnalysis.isForbidden) {
    verdict = 'REJECT';
  } else if (overallScore >= 85 && actualMargin >= 0.35) {
    verdict = 'TOP';
  } else if (overallScore >= 75 && actualMargin >= 0.3) {
    verdict = 'HIGH';
  } else if (overallScore >= 65 && actualMargin >= 0.25) {
    verdict = 'GOOD';
  } else if (overallScore >= 50) {
    verdict = 'MARGINAL';
  } else if (russiaAnalysis.isLogisticsRisk || russiaAnalysis.isRestricted) {
    verdict = 'RISK';
  } else {
    verdict = 'LOW';
  }

  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const actionItems: string[] = [];

  if (russiaAnalysis.isHighDemand) {
    strengths.push('🌟 符合俄罗斯市场高需求品类');
  }
  if (russiaAnalysis.autoPartAnalysis?.isAutoPart && russiaAnalysis.autoPartAnalysis.diyFriendliness >= 70) {
    strengths.push('🔧 汽配/DIY友好，车主自行更换');
  }
  if (actualMargin >= 0.4) {
    strengths.push(`💰 利润率${(actualMargin * 100).toFixed(0)}%，高于同行`);
  }
  if (competitionLevel >= 75) {
    strengths.push('🎯 竞争度较低，新店容易切入');
  }
  if (repeatPurchaseScore >= 75) {
    strengths.push('🔄 高复购产品，稳定持续收益');
  }
  if (logisticsFriendlinessScore >= 80) {
    strengths.push('📦 物流友好，包装运输简单');
  }
  if (seasonalMatchScore >= 80) {
    strengths.push(`📅 当前${russiaAnalysis.seasonalInfo?.currentSeason}旺季产品`);
  }
  if (opts.weightKg <= 1) {
    strengths.push(`⚖️ 重量${opts.weightKg}kg，运费成本低`);
  }
  if (brandRiskScore >= 80) {
    strengths.push('✅ 无品牌风险，合规销售');
  }
  if (profitInfo.totalCostRub <= 500) {
    strengths.push('💎 低成本商品，试错风险低');
  }

  if (russiaAnalysis.isForbidden) {
    weaknesses.push('❌ 俄罗斯市场禁止销售');
  }
  if (actualMargin < 0.2) {
    weaknesses.push(`⚠️ 利润率仅${(actualMargin * 100).toFixed(0)}%，偏低`);
  }
  if (competitionLevel < 50) {
    weaknesses.push('⚔️ 竞争激烈，需要差异化策略');
  }
  if (russiaAnalysis.isLogisticsRisk) {
    weaknesses.push('📦 存在物流风险，需特殊处理');
  }
  if (brandRiskScore < 50) {
    weaknesses.push('⚠️ 疑似品牌商品，有被查风险');
  }
  if (opts.weightKg > 5) {
    weaknesses.push(`⚖️ 重量${opts.weightKg}kg，运费较高`);
  }
  if (seasonalMatchScore < 50) {
    weaknesses.push('📅 当前季节需求偏弱');
  }
  if (repeatPurchaseScore < 50) {
    weaknesses.push('🔄 一次性产品，缺乏复购收益');
  }

  if (verdict === 'TOP' || verdict === 'HIGH') {
    actionItems.push(`🔥 【强烈推荐】建议定价₽${targetPrice}，每件预计利润₽${Math.round(estimatedProfitPerUnit)}`);
    actionItems.push(`📝 立即上架，优先铺货10-20件测试`);
    actionItems.push(`🎨 优化主图和标题，突出${russiaAnalysis.isHighDemand ? '俄罗斯需求' : ''}${russiaAnalysis.autoPartAnalysis?.isAutoPart ? 'DIY特点' : ''}`);
    if (repeatPurchaseScore >= 75) {
      actionItems.push(`🔄 可做多件优惠，鼓励批量购买`);
    }
  } else if (verdict === 'GOOD') {
    actionItems.push(`✅ 【推荐】建议定价₽${targetPrice}，利润₽${Math.round(estimatedProfitPerUnit)}`);
    actionItems.push(`📝 可适量上架5-10件，观察销售数据`);
    if (weaknesses.length > 0) {
      actionItems.push(`⚡ 关注并改善以下问题：${weaknesses.slice(0, 2).map(w => w.replace(/[⚠️⚔️📦❌⚖️📅🔄]/g, '').trim()).join('、')}`);
    }
  } else if (verdict === 'MARGINAL') {
    actionItems.push(`🤔 【谨慎】可考虑但需优化，建议成本再降10-15%`);
    actionItems.push(`📊 先找更低成本供应商，或寻找差异化卖点`);
  } else if (verdict === 'RISK') {
    actionItems.push(`⚠️ 【风险】不建议新手上架，除非有特殊渠道`);
    if (russiaAnalysis.isLogisticsRisk) {
      actionItems.push(`📦 可考虑使用本地仓/特殊物流渠道`);
    }
  } else {
    actionItems.push(`❌ 【不推荐】直接放弃，寻找其他商品`);
  }

  if (!russiaAnalysis.isForbidden && !russiaAnalysis.isLogisticsRisk) {
    const matchedTrends = ONZO_HISTORICAL_TRENDS.filter(t => t.hotKeywords.some(k => content.includes(k)));
    if (matchedTrends.length > 0) {
      actionItems.push(`💡 参考Onzo平台历史热销品类：${matchedTrends[0].category} - ${matchedTrends[0].recommendation}`);
    }
  }

  const categoryTags: string[] = [];
  if (russiaAnalysis.isHighDemand) categoryTags.push('高需求');
  if (russiaAnalysis.autoPartAnalysis?.isAutoPart) categoryTags.push('汽配');
  if (repeatPurchaseScore >= 75) categoryTags.push('高复购');
  if (competitionLevel >= 75) categoryTags.push('低竞争');
  if (actualMargin >= 0.4) categoryTags.push('高利润');
  if (seasonalMatchScore >= 80) categoryTags.push('当季');
  if (opts.weightKg <= 1) categoryTags.push('轻小件');
  if (logisticsFriendlinessScore >= 80) categoryTags.push('易物流');

  const currentMonth2 = new Date().getMonth() + 1;
  const isSeasonalProduct = seasonalMatchScore >= 80 || 
    (russiaAnalysis.seasonalInfo?.peakCategories || []).some(cat => {
      const categoryContent = `${title} ${description}`.toLowerCase();
      return ['冬季', '夏季', '春季', '秋季'].some(s => s.includes(cat.substring(0, 2)) || categoryContent.includes(cat.substring(0, 2)));
    });

  return {
    product: scraped,
    score: {
      overall: overallScore,
      marketDemand: marketDemandScore,
      profitPotential,
      competitionLevel,
      diyFriendliness: diyFriendlinessScore,
      logisticsFriendliness: logisticsFriendlinessScore,
      seasonality: seasonalMatchScore,
      repeatPurchase: repeatPurchaseScore,
      brandRisk: brandRiskScore,
      complianceScore
    },
    overallScore,
    verdict,
    recommendedPriceRub: targetPrice,
    estimatedProfitPerUnit: Math.round(estimatedProfitPerUnit),
    strengths,
    weaknesses,
    actionItems,
    categoryTags,
    isAutoPart: russiaAnalysis.autoPartAnalysis?.isAutoPart || false,
    isHighDemand: russiaAnalysis.isHighDemand,
    isLogisticsRisk: russiaAnalysis.isLogisticsRisk,
    isForbidden: russiaAnalysis.isForbidden,
    isSeasonal: isSeasonalProduct && (currentMonth2 >= 9 || currentMonth2 <= 3)
  };
}

export function batchAnalyzeBlueOcean(
  products: ScrapedProduct[],
  competitorsMap: Map<string, { priceRub: number; salesVolume?: number }[]> = new Map(),
  options?: {
    exchangeRate?: number;
    defaultWeightKg?: number;
    topN?: number;
  }
): {
  recommended: BlueOceanAnalysis[];
  consider: BlueOceanAnalysis[];
  rejected: BlueOceanAnalysis[];
  summary: {
    totalProducts: number;
    recommendCount: number;
    considerCount: number;
    rejectedCount: number;
    avgOverallScore: number;
    topCategories: string[];
    seasonalTips: string[];
  };
} {
  const results = products.map(p => {
    const weight = parseFloat(String(p.specifications?.['weight'] || p.specifications?.['重量'] || options?.defaultWeightKg || '0.3'));
    return analyzeForBlueOcean(p, competitorsMap.get(p.sourceUrl) || [], {
      exchangeRate: options?.exchangeRate || 12.5,
      weightKg: weight
    });
  });

  const sorted = [...results].sort((a, b) => b.overallScore - a.overallScore);
  const recommended = sorted.filter(r => r.verdict === 'TOP' || r.verdict === 'HIGH');
  const consider = sorted.filter(r => r.verdict === 'GOOD' || r.verdict === 'MARGINAL');
  const rejected = sorted.filter(r => r.verdict === 'RISK' || r.verdict === 'REJECT' || r.verdict === 'LOW');

  const avgScore = Math.round(results.reduce((sum, r) => sum + r.overallScore, 0) / Math.max(results.length, 1));

  const categoryCount = new Map<string, number>();
  results.forEach(r => r.categoryTags.forEach(tag => categoryCount.set(tag, (categoryCount.get(tag) || 0) + 1)));
  const topCategories = [...categoryCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([tag]) => tag);

  const seasonalInfo = results[0]?.product ? analyzeProductForRussia(results[0].product.title, '', []).seasonalInfo : null;
  const seasonalTips: string[] = [];
  if (seasonalInfo) {
    seasonalTips.push(`当前${seasonalInfo.currentSeason}，季节评分${seasonalInfo.seasonalScore}/100`);
    seasonalTips.push(`重点品类: ${seasonalInfo.peakCategories.slice(0, 3).join('、')}`);
  }

  return {
    recommended,
    consider,
    rejected,
    summary: {
      totalProducts: products.length,
      recommendCount: recommended.length,
      considerCount: consider.length,
      rejectedCount: rejected.length,
      avgOverallScore: avgScore,
      topCategories,
      seasonalTips
    }
  };
}

export function getOnzoSalesTrends(): OnzoSalesTrend[] {
  return ONZO_HISTORICAL_TRENDS.sort((a, b) => b.salesGrowth - a.salesGrowth);
}

export function getTopBlueOceanCategories(): { category: string; score: number; why: string }[] {
  const results: { category: string; score: number; why: string }[] = [];
  
  const highDemandCats = getHighDemandCategoriesForCurrentSeason();
  const autoCats = getAutoPartCategoriesSorted();

  highDemandCats.slice(0, 5).forEach((cat: CategoryDemandConfig & { boostedDemand?: number }, idx) => {
    results.push({
      category: cat.category,
      score: (cat as any).boostedDemand || cat.demandScore,
      why: `${cat.description || '高需求'}。利润率${((cat.avgProfitMargin || 0.3) * 100).toFixed(0)}%，需求评分${cat.demandScore}/100`
    });
  });

  autoCats.slice(0, 5).forEach((cat: AutoPartCategory & { overallScore?: number }) => {
    results.push({
      category: `【汽配】${cat.category}`,
      score: (cat as any).overallScore || cat.marketSize,
      why: `${cat.description}。平均利润${cat.avgProfit}%，DIY难度${cat.diyDifficulty}/100`
    });
  });

  return results.sort((a, b) => b.score - a.score);
}

export function getKeywordRecommendations(): { type: string; keywords: string[]; tips: string }[] {
  return [
    {
      type: '🔥 当季爆款关键词',
      keywords: ['保暖', '羽绒服', '棉衣', '雪地靴', '手套', '帽子', '保温', '防滑', '防冻液', '玻璃水'],
      tips: '冬季热门商品，注意提前备货和库存深度'
    },
    {
      type: '🔧 汽配刚需关键词',
      keywords: ['机油', '滤清器', '雨刷', '刹车片', '脚垫', '座套', '方向盘套', '应急', '搭电线', '千斤顶'],
      tips: '俄罗斯DIY保养文化盛行，高复购高利润'
    },
    {
      type: '🛠 家庭维修关键词',
      keywords: ['螺丝刀', '扳手', '工具套装', '密封胶', '免钉胶', '膨胀螺丝', '电钻', '钳子', '卷尺'],
      tips: '刚需稳定，物流简单，适合新店入门'
    },
    {
      type: '📦 家居收纳关键词',
      keywords: ['收纳盒', '收纳袋', '挂钩', '置物架', '衣架', '收纳箱', '垃圾桶', '纸巾盒'],
      tips: '低物流成本，易批量销售'
    },
    {
      type: '🧹 清洁消耗关键词',
      keywords: ['清洁布', '魔术擦', '海绵', '拖把', '清洁工具', '毛巾', '洗碗布', '洗衣袋'],
      tips: '高频复购，利润率高'
    },
    {
      type: '🚫 需避免的关键词',
      keywords: ['电子烟', '药品', '仿品', '复刻', '液体', '玻璃', '食品', '宠物活体', '武器'],
      tips: '禁止/高风险品类，避免浪费时间和成本'
    }
  ];
}