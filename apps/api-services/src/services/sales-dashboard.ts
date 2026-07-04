export interface DailySales {
  date: string;
  orders: number;
  revenueRub: number;
  profitRub: number;
  avgOrderValue: number;
  conversionRate: number;
}

export interface ProductPerformance {
  productId: number;
  title: string;
  sku: number;
  sales: number;
  revenueRub: number;
  profitRub: number;
  margin: number;
  stock: number;
  rating: number;
  reviewCount: number;
}

export interface CategoryPerformance {
  category: string;
  sales: number;
  revenueRub: number;
  profitRub: number;
  margin: number;
  productCount: number;
}

export interface KeyMetrics {
  totalOrders: number;
  totalRevenueRub: number;
  totalProfitRub: number;
  avgOrderValue: number;
  conversionRate: number;
  refundRate: number;
  avgRating: number;
  activeProducts: number;
  outOfStockProducts: number;
}

export interface SalesTrend {
  period: 'day' | 'week' | 'month';
  labels: string[];
  revenue: number[];
  orders: number[];
  profit: number[];
}

export class SalesDashboard {
  private dailySales = new Map<string, DailySales>();
  private productPerformance = new Map<number, ProductPerformance>();
  private categoryPerformance = new Map<string, CategoryPerformance>();

  recordSale(data: {
    date: string;
    productId: number;
    sku: number;
    title: string;
    category: string;
    quantity: number;
    priceRub: number;
    costRub: number;
  }): void {
    const dailyKey = data.date;
    const daily = this.dailySales.get(dailyKey) || {
      date: data.date,
      orders: 0,
      revenueRub: 0,
      profitRub: 0,
      avgOrderValue: 0,
      conversionRate: 0
    };
    
    daily.orders += data.quantity;
    daily.revenueRub += data.priceRub * data.quantity;
    daily.profitRub += (data.priceRub - data.costRub) * data.quantity;
    this.dailySales.set(dailyKey, daily);

    const product = this.productPerformance.get(data.productId) || {
      productId: data.productId,
      title: data.title,
      sku: data.sku,
      sales: 0,
      revenueRub: 0,
      profitRub: 0,
      margin: 0,
      stock: 0,
      rating: 0,
      reviewCount: 0
    };
    
    product.sales += data.quantity;
    product.revenueRub += data.priceRub * data.quantity;
    product.profitRub += (data.priceRub - data.costRub) * data.quantity;
    product.margin = product.revenueRub > 0 
      ? product.profitRub / product.revenueRub 
      : 0;
    this.productPerformance.set(data.productId, product);

    const cat = this.categoryPerformance.get(data.category) || {
      category: data.category,
      sales: 0,
      revenueRub: 0,
      profitRub: 0,
      margin: 0,
      productCount: 0
    };
    
    cat.sales += data.quantity;
    cat.revenueRub += data.priceRub * data.quantity;
    cat.profitRub += (data.priceRub - data.costRub) * data.quantity;
    cat.margin = cat.revenueRub > 0 
      ? cat.profitRub / cat.revenueRub 
      : 0;
    this.categoryPerformance.set(data.category, cat);
  }

  updateProductInfo(productId: number, updates: Partial<Pick<ProductPerformance, 'stock' | 'rating' | 'reviewCount'>>): void {
    const product = this.productPerformance.get(productId);
    if (product) {
      if (updates.stock !== undefined) product.stock = updates.stock;
      if (updates.rating !== undefined) product.rating = updates.rating;
      if (updates.reviewCount !== undefined) product.reviewCount = updates.reviewCount;
    }
  }

  getKeyMetrics(): KeyMetrics {
    const allDaily = Array.from(this.dailySales.values());
    const allProducts = Array.from(this.productPerformance.values());
    
    const totalOrders = allDaily.reduce((sum, d) => sum + d.orders, 0);
    const totalRevenueRub = allDaily.reduce((sum, d) => sum + d.revenueRub, 0);
    const totalProfitRub = allDaily.reduce((sum, d) => sum + d.profitRub, 0);
    const avgOrderValue = totalOrders > 0 
      ? Math.round(totalRevenueRub / totalOrders) 
      : 0;
    
    const refundOrders = 0;
    const refundRate = totalOrders > 0 
      ? (refundOrders / totalOrders) * 100 
      : 0;
    
    const ratedProducts = allProducts.filter(p => p.reviewCount > 0);
    const avgRating = ratedProducts.length > 0 
      ? ratedProducts.reduce((sum, p) => sum + p.rating, 0) / ratedProducts.length 
      : 0;
    
    const activeProducts = allProducts.filter(p => p.stock > 0).length;
    const outOfStockProducts = allProducts.filter(p => p.stock === 0).length;

    return {
      totalOrders,
      totalRevenueRub: Math.round(totalRevenueRub),
      totalProfitRub: Math.round(totalProfitRub),
      avgOrderValue,
      conversionRate: 0,
      refundRate: Math.round(refundRate * 10) / 10,
      avgRating: Math.round(avgRating * 10) / 10,
      activeProducts,
      outOfStockProducts
    };
  }

  getSalesTrend(period: 'day' | 'week' | 'month'): SalesTrend {
    const now = new Date();
    const labels: string[] = [];
    const revenue: number[] = [];
    const orders: number[] = [];
    const profit: number[] = [];
    
    let days = 7;
    if (period === 'month') days = 30;
    else if (period === 'day') days = 1;

    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      
      labels.push(dateStr);
      
      const daily = this.dailySales.get(dateStr);
      revenue.push(daily?.revenueRub || 0);
      orders.push(daily?.orders || 0);
      profit.push(daily?.profitRub || 0);
    }

    return { period, labels, revenue, orders, profit };
  }

  getTopProducts(limit: number = 10): ProductPerformance[] {
    return Array.from(this.productPerformance.values())
      .sort((a, b) => b.revenueRub - a.revenueRub)
      .slice(0, limit);
  }

  getTopCategories(limit: number = 5): CategoryPerformance[] {
    return Array.from(this.categoryPerformance.values())
      .sort((a, b) => b.revenueRub - a.revenueRub)
      .slice(0, limit);
  }

  getLowStockProducts(threshold: number = 5): ProductPerformance[] {
    return Array.from(this.productPerformance.values())
      .filter(p => p.stock > 0 && p.stock <= threshold)
      .sort((a, b) => a.stock - b.stock);
  }

  getPoorPerformingProducts(minMargin: number = 0.2): ProductPerformance[] {
    return Array.from(this.productPerformance.values())
      .filter(p => p.sales > 0 && p.margin < minMargin)
      .sort((a, b) => a.margin - b.margin);
  }
}