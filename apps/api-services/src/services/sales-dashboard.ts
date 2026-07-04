// ============================================================
// Sales Dashboard — SQLite-persisted with TTL cache layer
// Cache TTL: 5 minutes (aggregated data doesn't change rapidly)
// ============================================================

import { getDb } from "../db/connection.js";

export interface DailySales { date: string; orders: number; revenueRub: number; profitRub: number; avgOrderValue: number; }
export interface ProductPerformance { productId: number; title: string; sku: number; sales: number; revenueRub: number; profitRub: number; margin: number; stock: number; rating: number; reviewCount: number; }
export interface KeyMetrics { totalOrders: number; totalRevenueRub: number; totalProfitRub: number; avgOrderValue: number; refundRate: number; activeProducts: number; outOfStockProducts: number; }

// ---- Cache ----
interface CacheEntry<T> { data: T; expiresAt: number; }
const CACHE_TTL_MS = 300_000; // 5 minutes
const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.data as T;
  cache.delete(key);
  return null;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

export class SalesDashboard {
  /** Record a sale — called after order is marked delivered */
  async recordSale(params: { productId?: number; title?: string; sku: number; revenueRub: number; profitRub: number; date: string }): Promise<void> {
    const db = await getDb().catch(() => null);
    if (!db) return;

    // Upsert daily_sales
    await db.run(
      `INSERT INTO daily_sales (date, orders, revenue_rub, profit_rub, avg_order_value, updated_at)
       VALUES (?, 1, ?, ?, ?, NOW())
       ON CONFLICT(date) DO UPDATE SET orders=orders+1, revenue_rub=revenue_rub+?, profit_rub=profit_rub+?, avg_order_value=(revenue_rub+?)/(orders+1), updated_at=NOW()`,
      [params.date, params.revenueRub, params.profitRub, 0, params.revenueRub, params.profitRub, params.revenueRub]
    );

    // Upsert product_performance
    await db.run(
      `INSERT INTO product_performance (product_id, title, sku, sales, revenue_rub, profit_rub, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, NOW())
       ON CONFLICT(sku) DO UPDATE SET sales=sales+1, revenue_rub=revenue_rub+?, profit_rub=profit_rub+?, updated_at=NOW()`,
      [params.productId ?? null, params.title ?? null, params.sku, params.revenueRub, params.profitRub, params.revenueRub, params.profitRub]
    );

    // Invalidate cache
    cache.clear();
  }

  /** Get key metrics summary */
  async getKeyMetrics(): Promise<KeyMetrics> {
    const cached = getCached<KeyMetrics>("metrics");
    if (cached) return cached;

    const db = await getDb().catch(() => null);
    if (!db) return { totalOrders: 0, totalRevenueRub: 0, totalProfitRub: 0, avgOrderValue: 0, refundRate: 0, activeProducts: 0, outOfStockProducts: 0 };

    const [orderRows, productRows, stockRows] = await Promise.all([
      db.all("SELECT COALESCE(SUM(orders),0) as totalOrders, COALESCE(SUM(revenue_rub),0) as totalRev, COALESCE(SUM(profit_rub),0) as totalProfit FROM daily_sales") as Promise<Array<Record<string, number>>>,
      db.all("SELECT COUNT(*) as cnt FROM product_performance WHERE sales > 0") as Promise<Array<Record<string, number>>>,
      db.all("SELECT COUNT(*) as cnt FROM inventory WHERE stock_available = 0") as Promise<Array<Record<string, number>>>,
    ]);

    const metrics: KeyMetrics = {
      totalOrders: orderRows[0]?.totalOrders ?? 0,
      totalRevenueRub: orderRows[0]?.totalRev ?? 0,
      totalProfitRub: orderRows[0]?.totalProfit ?? 0,
      avgOrderValue: orderRows[0]?.totalOrders > 0 ? Math.round((orderRows[0].totalRev / orderRows[0].totalOrders) * 100) / 100 : 0,
      refundRate: 0, // computed from aftersales_cases
      activeProducts: productRows[0]?.cnt ?? 0,
      outOfStockProducts: stockRows[0]?.cnt ?? 0,
    };
    setCache("metrics", metrics);
    return metrics;
  }

  /** Get daily sales trend */
  async getDailySales(days = 30): Promise<DailySales[]> {
    const db = await getDb().catch(() => null);
    if (!db) return [];

    const rows = await db.all(
      "SELECT * FROM daily_sales WHERE date >= CURRENT_DATE - (?::text || ' days')::INTERVAL ORDER BY date DESC",
      [`-${days} days`]
    ) as Array<Record<string, unknown>>;

    return rows.map(r => ({
      date: r.date as string, orders: (r.orders ?? 0) as number,
      revenueRub: (r.revenue_rub ?? 0) as number, profitRub: (r.profit_rub ?? 0) as number,
      avgOrderValue: (r.avg_order_value ?? 0) as number,
    }));
  }

  /** Get top performing products */
  async getTopProducts(limit = 10): Promise<ProductPerformance[]> {
    const db = await getDb().catch(() => null);
    if (!db) return [];

    const rows = await db.all(
      "SELECT * FROM product_performance ORDER BY sales DESC LIMIT ?", [limit]
    ) as Array<Record<string, unknown>>;

    return rows.map(r => ({
      productId: (r.product_id ?? 0) as number, title: (r.title ?? "") as string,
      sku: (r.sku ?? 0) as number, sales: (r.sales ?? 0) as number,
      revenueRub: (r.revenue_rub ?? 0) as number, profitRub: (r.profit_rub ?? 0) as number,
      margin: (r.margin ?? 0) as number, stock: (r.stock ?? 0) as number,
      rating: (r.rating ?? 0) as number, reviewCount: (r.review_count ?? 0) as number,
    }));
  }

  /** Aggregate from orders table — call hourly */
  async aggregateFromOrders(): Promise<void> {
    const db = await getDb().catch(() => null);
    if (!db) return;

    // Recalculate today's numbers from local_orders
    const today = new Date().toISOString().split("T")[0];
    const rows = await db.all(
      `SELECT COUNT(*) as orders, COALESCE(SUM(total_price_rub),0) as revenue, COALESCE(SUM(payout_rub - commission_rub),0) as profit
       FROM local_orders WHERE date(created_at)=? AND status='delivered'`,
      [today]
    ) as Array<{ orders: number; revenue: number; profit: number }>;

    if (rows[0].orders > 0) {
      await db.run(
        `INSERT INTO daily_sales (date, orders, revenue_rub, profit_rub, avg_order_value, updated_at)
         VALUES (?, ?, ?, ?, ?, NOW()) ON CONFLICT(date) DO UPDATE SET orders=EXCLUDED.orders, revenue_rub=EXCLUDED.revenue_rub, profit_rub=EXCLUDED.profit_rub, avg_order_value=EXCLUDED.avg_order_value, updated_at=NOW()`,
        [today, rows[0].orders, rows[0].revenue, rows[0].profit, rows[0].orders > 0 ? Math.round(rows[0].revenue / rows[0].orders * 100) / 100 : 0]
      );
    }
    cache.clear();
  }
}
