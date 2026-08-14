// ============================================================
// Promo DB queries — raw SQL (PG + SQLite compatible)
// Drizzle ORM schema definitions available in drizzle-schema*.ts
// ============================================================

import { getDb, type DbAdapter } from "./connection.js";
import { getAdDailyStats } from "../services/ozon-ads.js";

async function db(): Promise<DbAdapter> {
  const d = await getDb();
  if (!d) throw new Error("DB unavailable");
  return d;
}

// ---- Watch List ----

export async function queryWatchList(): Promise<Array<{ offerId: string; name: string; addedAt: string | null }>> {
  const d = await db();
  return d.all("SELECT offer_id AS offerId, name, added_at AS addedAt FROM promo_watch_list ORDER BY added_at DESC");
}

export async function insertWatchItem(offerId: string, name: string): Promise<void> {
  const d = await db();
  await d.run("INSERT OR REPLACE INTO promo_watch_list (offer_id, name) VALUES (?, ?)", [offerId, name]);
}

export async function deleteWatchItem(offerId: string): Promise<void> {
  const d = await db();
  await d.run("DELETE FROM promo_watch_list WHERE offer_id = ?", [offerId]);
}

// ---- Competitor Prices ----

export async function queryCompetitorPrices(offerId: string, days: number): Promise<Array<{ price: number; rating: number; salesCount: number; capturedAt: string | null; competitorUrl: string }>> {
  const d = await db();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return d.all(
    "SELECT price, rating, sales_count AS salesCount, captured_at AS capturedAt, competitor_url AS competitorUrl FROM promo_competitor_prices WHERE offer_id = ? AND captured_at >= ? ORDER BY captured_at DESC",
    [offerId, cutoff],
  );
}

export async function insertCompetitorPrices(
  offerId: string,
  prices: Array<{ price: number; rating?: number; salesCount?: number; capturedAt?: string }>,
): Promise<number> {
  const d = await db();
  let count = 0;
  for (const p of prices) {
    await d.run(
      "INSERT INTO promo_competitor_prices (offer_id, price, rating, sales_count, captured_at) VALUES (?, ?, ?, ?, ?)",
      [offerId, p.price, p.rating || 0, p.salesCount || 0, p.capturedAt || new Date().toISOString()],
    );
    count++;
  }
  return count;
}

// ---- Competitor Links (精准监控：选品留档的指定竞品链接) ----

export interface CompetitorLinkRow {
  offerId: string;
  competitorUrl: string;
  competitorName: string;
  lastCapturedAt: string | null;
}

/** 列出竞品链接（可按我方 offerId 过滤），附带该链接最近一次快照时间 */
export async function queryCompetitorLinks(offerId?: string): Promise<CompetitorLinkRow[]> {
  const d = await db();
  const where = offerId ? "WHERE l.offer_id = ?" : "";
  const params = offerId ? [offerId] : [];
  return d.all(
    `SELECT l.offer_id AS "offerId", l.competitor_url AS "competitorUrl", l.competitor_name AS "competitorName",
            (SELECT MAX(p.captured_at) FROM promo_competitor_prices p
              WHERE p.offer_id = l.offer_id AND p.competitor_url = l.competitor_url) AS "lastCapturedAt"
     FROM promo_competitor_links l ${where} ORDER BY l.offer_id, l.id`,
    params,
  );
}

export async function insertCompetitorLink(offerId: string, competitorUrl: string, competitorName = ""): Promise<void> {
  const d = await db();
  await d.run(
    "INSERT INTO promo_competitor_links (offer_id, competitor_url, competitor_name) VALUES (?, ?, ?) ON CONFLICT(offer_id, competitor_url) DO NOTHING",
    [offerId, competitorUrl, competitorName],
  );
}

/** 批量写入精准竞品快照（每条绑定具体 competitor_url） */
export async function insertCompetitorSnapshots(
  offerId: string,
  snapshots: Array<{ competitorUrl: string; price: number; rating?: number; salesCount?: number; capturedAt?: string }>,
): Promise<number> {
  const d = await db();
  let count = 0;
  for (const s of snapshots) {
    await d.run(
      "INSERT INTO promo_competitor_prices (offer_id, competitor_url, price, rating, sales_count, captured_at) VALUES (?, ?, ?, ?, ?, ?)",
      [offerId, s.competitorUrl, s.price, s.rating || 0, s.salesCount || 0, s.capturedAt || new Date().toISOString()],
    );
    count++;
  }
  return count;
}

// ---- Events ----

export async function queryEvents(type?: string): Promise<Array<{ type: string; payload: unknown; createdAt: string | null }>> {
  const d = await db();
  const rows = type
    ? await d.all("SELECT type, payload_json AS payloadJson, created_at AS createdAt FROM promo_events WHERE type = ? ORDER BY created_at DESC LIMIT 100", [type])
    : await d.all("SELECT type, payload_json AS payloadJson, created_at AS createdAt FROM promo_events ORDER BY created_at DESC LIMIT 100");
  return rows.map((r: Record<string, unknown>) => ({
    type: r.type as string,
    payload: typeof r.payloadJson === "string" ? JSON.parse(r.payloadJson as string) : (r.payloadJson || {}),
    createdAt: r.createdAt as string | null,
  }));
}

export async function insertEvent(type: string, payload: Record<string, unknown>): Promise<void> {
  const d = await db();
  await d.run("INSERT INTO promo_events (type, payload_json) VALUES (?, ?)", [type, JSON.stringify(payload)]);
}

// ---- Pricing History ----

export async function queryPricingHistory(days: number): Promise<Array<Record<string, unknown>>> {
  const d = await db();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return d.all(
    "SELECT offer_id AS offerId, name, old_price AS oldPrice, new_price AS newPrice, reason, sales_before AS salesBefore, sales_after_7d AS salesAfter, applied_at AS appliedAt FROM promo_pricing_history WHERE applied_at >= ? ORDER BY applied_at DESC",
    [cutoff],
  );
}

export async function insertPricingHistory(entry: { offerId: string; name: string; oldPrice: number; newPrice: number; reason: string }): Promise<void> {
  const d = await db();
  await d.run(
    "INSERT INTO promo_pricing_history (offer_id, name, old_price, new_price, reason) VALUES (?, ?, ?, ?, ?)",
    [entry.offerId, entry.name, entry.oldPrice, entry.newPrice, entry.reason],
  );
}

// ---- Copy History ----

export async function queryCopyHistory(days: number): Promise<Array<Record<string, unknown>>> {
  const d = await db();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return d.all(
    "SELECT offer_id AS offerId, name, title_ru AS titleRu, sales_before AS salesBefore, sales_after_7d AS salesAfter, applied_at AS appliedAt FROM promo_copy_history WHERE applied_at >= ? ORDER BY applied_at DESC",
    [cutoff],
  );
}

export async function insertCopyHistory(entry: { offerId: string; name: string; titleRu: string }): Promise<void> {
  const d = await db();
  await d.run("INSERT INTO promo_copy_history (offer_id, name, title_ru) VALUES (?, ?, ?)", [entry.offerId, entry.name, entry.titleRu]);
}

// ---- Decisions & Audit ----

export async function insertDecision(id: string, planJson: string): Promise<void> {
  const d = await db();
  await d.run("INSERT OR REPLACE INTO promo_decisions (id, plan_json, status) VALUES (?, ?, 'submitted')", [id, planJson]);
}

export async function insertAuditLog(entry: { actionType: string; offerId: string | null; details: Record<string, unknown>; operator?: string }): Promise<void> {
  const d = await db();
  await d.run(
    "INSERT INTO promo_audit_log (action_type, offer_id, details_json, operator) VALUES (?, ?, ?, ?)",
    [entry.actionType, entry.offerId, JSON.stringify(entry.details), entry.operator || "auto"],
  );
}

// ---- Stats & Sales ----

export interface SalesRankingItem {
  offerId: string;
  name: string;
  orders: number;
  revenue: number;
}

/** 销量榜 — 从 ozon_orders.products_json 聚合（product_performance 为空表，弃用） */
export async function querySalesRanking(days: number): Promise<SalesRankingItem[]> {
  const d = await db();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await d.all(
    "SELECT products_json FROM ozon_orders WHERE created_at_ozon >= ? AND status != 'cancelled'",
    [cutoff],
  );
  const agg = new Map<string, SalesRankingItem>();
  for (const r of rows) {
    let products: Array<{ offerId?: string; name?: string; quantity?: number; price?: number }>;
    try {
      products = JSON.parse(String((r as Record<string, unknown>).products_json || "[]"));
    } catch {
      continue; // 跳过损坏的 JSON 行
    }
    if (!Array.isArray(products)) continue;
    for (const p of products) {
      const offerId = String(p.offerId || "");
      if (!offerId) continue;
      const qty = Number(p.quantity || 0);
      const entry = agg.get(offerId) || { offerId, name: "", orders: 0, revenue: 0 };
      entry.orders += qty;
      entry.revenue += Number(p.price || 0) * qty;
      if (!entry.name && p.name) entry.name = String(p.name);
      agg.set(offerId, entry);
    }
  }
  return [...agg.values()].sort((a, b) => b.orders - a.orders).slice(0, 20);
}

export interface DailyStats {
  orders: number;
  revenue: number;
  avgOrderValue: number;
  cancelledOrders: number;
}

/** 日报数据 — 真实订单来自 ozon_orders（daily_sales 表无写入方，弃用） */
export async function queryDailyStats(date: string): Promise<DailyStats> {
  const d = await db();
  const rows = await d.all(
    "SELECT COUNT(*) AS cnt, COALESCE(SUM(total_price_rub), 0) AS revenue FROM ozon_orders WHERE date(created_at_ozon) = ? AND status != 'cancelled'",
    [date],
  );
  const cancelledRows = await d.all(
    "SELECT COUNT(*) AS cnt FROM ozon_orders WHERE date(created_at_ozon) = ? AND status = 'cancelled'",
    [date],
  );
  const orders = Number((rows[0] as Record<string, unknown> | undefined)?.cnt || 0);
  const revenue = Number((rows[0] as Record<string, unknown> | undefined)?.revenue || 0);
  const cancelledOrders = Number((cancelledRows[0] as Record<string, unknown> | undefined)?.cnt || 0);
  return { orders, revenue, avgOrderValue: orders > 0 ? revenue / orders : 0, cancelledOrders };
}

/** 按天聚合订单（周报趋势图） */
export async function queryOrdersByDay(fromDate: string, toDate: string): Promise<Array<{ date: string; orders: number; revenue: number }>> {
  const d = await db();
  const rows = await d.all(
    "SELECT date(created_at_ozon) AS date, COUNT(*) AS orders, COALESCE(SUM(total_price_rub), 0) AS revenue FROM ozon_orders WHERE date(created_at_ozon) BETWEEN ? AND ? AND status != 'cancelled' GROUP BY date(created_at_ozon) ORDER BY date(created_at_ozon)",
    [fromDate, toDate],
  );
  return rows.map((r) => {
    const row = r as Record<string, unknown>;
    return { date: String(row.date || ""), orders: Number(row.orders || 0), revenue: Number(row.revenue || 0) };
  });
}

export interface PromoCostStats {
  adSpend: number | null; // null = 广告 API 未接入/失败（区别于真实 0）
  totalRevenue: number;
  organicRevenue: number | null;
  paidRevenue: number | null;
  roi: number | null;
}

/** 推广成本 — 广告费来自 Ozon Performance API，收入来自 ozon_orders（token_usage 是 LLM 成本，弃用） */
export async function queryPromoCost(fromDate: string, toDate: string): Promise<PromoCostStats> {
  const d = await db();
  const rows = await d.all(
    "SELECT COALESCE(SUM(total_price_rub), 0) AS revenue FROM ozon_orders WHERE date(created_at_ozon) BETWEEN ? AND ? AND status != 'cancelled'",
    [fromDate, toDate],
  );
  const totalRevenue = Number((rows[0] as Record<string, unknown> | undefined)?.revenue || 0);
  const adStats = await getAdDailyStats(fromDate, toDate);
  if (!adStats) {
    return { adSpend: null, totalRevenue, organicRevenue: null, paidRevenue: null, roi: null };
  }
  const adSpend = adStats.spendRub;
  const paidRevenue = adStats.adRevenueRub;
  const organicRevenue = Math.max(0, totalRevenue - paidRevenue);
  const roi = adSpend > 0 ? paidRevenue / adSpend : null;
  return { adSpend, totalRevenue, organicRevenue, paidRevenue, roi };
}
