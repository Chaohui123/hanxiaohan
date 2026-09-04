// ============================================================
// Price Scanner — Ozon competitor price data collection
// Uses SQLite for storage (no Qdrant per Phase 2 constraint)
// ============================================================

export interface CompetitorPrice {
  platform: "ozon" | "wildberries";
  productSku: string;
  productTitle: string;
  priceRub: number;
  oldPriceRub?: number;
  sellerName?: string;
  rating?: number;
  reviewCount?: number;
  url: string;
  capturedAt: string;
}

export interface ScanResult {
  scanned: number;
  newPrices: number;
  updatedPrices: number;
  errors: string[];
}

export interface DbAdapter {
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** UTC cutoff in canonical DB format 'YYYY-MM-DD HH:MM:SS'（PG TIMESTAMP 与 SQLite TEXT 比较均正确） */
function dbCutoff(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Price comparison logic — no external API calls in Phase 2.
 * Accepts already-scraped price data and stores/compares it.
 */
export class PriceScanner {
  private db: DbAdapter;

  constructor(db: DbAdapter) {
    this.db = db;
  }

  /** Store a batch of competitor prices. Returns counts. */
  async ingestPrices(prices: CompetitorPrice[]): Promise<ScanResult> {
    const result: ScanResult = { scanned: prices.length, newPrices: 0, updatedPrices: 0, errors: [] };

    for (const p of prices) {
      try {
        // Check if we already have a price for this SKU+platform today
        const existing = await this.db.all(
          "SELECT id, price_rub FROM price_history WHERE product_sku = ? AND platform = ? AND date(captured_at) = date(?) LIMIT 1",
          [p.productSku, p.platform, p.capturedAt]
        );

        if (existing.length === 0) {
          result.newPrices++;
          await this.db.run(
            "INSERT INTO price_history (product_sku, platform, price_rub, source_url, captured_at) VALUES (?, ?, ?, ?, ?)",
            [p.productSku, p.platform, p.priceRub, p.url, p.capturedAt]
          );
        } else if (existing[0].price_rub !== p.priceRub) {
          result.updatedPrices++;
          await this.db.run(
            "INSERT INTO price_history (product_sku, platform, price_rub, source_url, captured_at) VALUES (?, ?, ?, ?, ?)",
            [p.productSku, p.platform, p.priceRub, p.url, p.capturedAt]
          );
        }
        // 同价同日已有记录 — 跳过，避免 price_history 重复行稀释 AVG/COUNT（2026-09-04 审查）
      } catch (err) {
        result.errors.push(`${p.productSku}: ${(err as Error).message}`);
      }
    }

    return result;
  }

  /** Get price trend for a SKU over N days. */
  async getPriceTrend(productSku: string, days: number = 30): Promise<Array<{ date: string; platform: string; avgPrice: number; minPrice: number; maxPrice: number; count: number }>> {
    // datetime('now',...) 是 SQLite 方言（PG 不存在该函数）— 用参数化 cutoff，两侧兼容；
    // 别名加双引号防 PG 折叠为小写（avgPrice → avgprice 取不到值）
    return this.db.all(
      `SELECT date(captured_at) as date, platform,
              ROUND(CAST(AVG(price_rub) AS numeric), 2) as "avgPrice",
              MIN(price_rub) as "minPrice", MAX(price_rub) as "maxPrice",
              COUNT(*) as "count"
       FROM price_history
       WHERE product_sku = ? AND captured_at >= ?
       GROUP BY date(captured_at), platform
       ORDER BY date DESC`,
      [productSku, dbCutoff(-days * 86400_000)]
    ) as Promise<Array<{ date: string; platform: string; avgPrice: number; minPrice: number; maxPrice: number; count: number }>>;
  }

  /** Compare a product's price across platforms. */
  async compareAcrossPlatforms(productSku: string): Promise<Array<{ platform: string; latestPrice: number; weekAvg: number; trend: "up" | "down" | "stable" }>> {
    const rows = await this.db.all(
      `SELECT platform, price_rub, captured_at FROM price_history
       WHERE product_sku = ? AND captured_at >= ?
       ORDER BY captured_at DESC`,
      [productSku, dbCutoff(-7 * 86400_000)]
    ) as Array<{ platform: string; price_rub: number; captured_at: string }>;

    const platforms = new Map<string, Array<{ price_rub: number; captured_at: string }>>();
    for (const r of rows) {
      if (!platforms.has(r.platform)) platforms.set(r.platform, []);
      platforms.get(r.platform)!.push(r);
    }

    return Array.from(platforms.entries()).map(([platform, prices]) => {
      const latest = prices[0].price_rub;
      const weekAvg = prices.reduce((s, p) => s + p.price_rub, 0) / prices.length;
      const trend: "up" | "down" | "stable" =
        prices.length < 2 ? "stable" :
        latest > weekAvg * 1.05 ? "up" :
        latest < weekAvg * 0.95 ? "down" : "stable";

      return { platform, latestPrice: Math.round(latest), weekAvg: Math.round(weekAvg), trend };
    });
  }
}
