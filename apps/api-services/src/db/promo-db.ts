// ============================================================
// Promo DB queries — raw SQL (PG + SQLite compatible)
// Drizzle ORM schema definitions available in drizzle-schema*.ts
// ============================================================

import { getDb, type DbAdapter } from "./connection.js";

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

export async function queryCompetitorPrices(offerId: string, days: number): Promise<Array<{ price: number; rating: number; salesCount: number; capturedAt: string | null }>> {
  const d = await db();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return d.all(
    "SELECT price, rating, sales_count AS salesCount, captured_at AS capturedAt FROM promo_competitor_prices WHERE offer_id = ? AND captured_at >= ? ORDER BY captured_at DESC",
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

export async function querySalesRanking(days: number): Promise<Array<Record<string, unknown>>> {
  const d = await db();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return d.all(
    "SELECT product_id AS offerId, COALESCE(title, '') AS name, sales AS orders, revenue_rub AS revenue FROM product_performance WHERE updated_at >= ? ORDER BY sales DESC LIMIT 20",
    [cutoff],
  );
}

export async function queryDailyStats(date: string): Promise<{ orders: number; revenue: number; avgOrderValue: number }> {
  const d = await db();
  const rows = await d.all("SELECT orders, revenue_rub AS revenue, avg_order_value AS avgOrderValue FROM daily_sales WHERE date = ?", [date]);
  const row = rows[0] as Record<string, unknown> | undefined;
  return { orders: Number(row?.orders || 0), revenue: Number(row?.revenue || 0), avgOrderValue: Number(row?.avgOrderValue || 0) };
}

export async function queryPromoCost(fromDate: string, toDate: string): Promise<Record<string, number>> {
  const d = await db();
  const tokenRows = await d.all("SELECT COALESCE(SUM(cost_estimate), 0) AS cost FROM token_usage WHERE DATE(timestamp) BETWEEN ? AND ?", [fromDate, toDate]);
  const salesRows = await d.all("SELECT COALESCE(SUM(revenue_rub), 0) AS revenue FROM daily_sales WHERE date BETWEEN ? AND ?", [fromDate, toDate]);
  const adSpend = (tokenRows[0] as Record<string, unknown> | undefined)?.cost as number || 0;
  const totalRevenue = (salesRows[0] as Record<string, unknown> | undefined)?.revenue as number || 0;
  const organicRevenue = totalRevenue * 0.7;
  const paidRevenue = totalRevenue * 0.3;
  const roi = adSpend > 0 ? paidRevenue / adSpend : 0;
  return { adSpend, totalRevenue, organicRevenue, paidRevenue, roi };
}
