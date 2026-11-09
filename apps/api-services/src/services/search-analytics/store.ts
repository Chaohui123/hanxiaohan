import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DbAdapter } from "../../db/connection.js";
import { getAdapterType } from "../../db/connection.js";
import { normalizeSearchBatch, SearchBatchError } from "./batch.js";
import { refreshDerivedWindow, getDerivedWindow } from "./derived-windows.js";

export type PublishOptions = { rawRoot?: string; dialect?: "pg" | "sqlite" };

async function insertMany(db: DbAdapter, table: string, rows: Array<Record<string, unknown>>, chunkSize: number): Promise<void> {
  if (!rows.length) return;
  const columns = Object.keys(rows[0]);
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const placeholders = chunk.map(() => `(${columns.map(() => "?").join(",")})`).join(",");
    const parameters = chunk.flatMap(row => columns.map(column => row[column] ?? null));
    await db.run(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${placeholders} ON CONFLICT DO NOTHING`, parameters);
  }
}

function parseJson(value: unknown, fallback: unknown): unknown {
  if (typeof value !== "string") return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function mapSearchRun(row: Record<string, unknown>): Record<string, unknown> {
  const manifest = parseJson(row.manifest_json, {}) as Record<string, unknown>;
  return {
    runId: row.run_id, companyId: row.company_id, status: row.status,
    sourceType: row.source_type, sourceDependency: row.source_dependency,
    nativePeriod: manifest.nativePeriod || { requested: row.native_period, start: row.period_start, end: row.period_end, timezone: row.timezone },
    anchorAt: row.anchor_at, filters: parseJson(row.filters_json, {}), filterHash: row.filter_hash,
    collectorVersion: row.collector_version, parserVersion: row.parser_version, coverage: row.coverage,
    expectedPages: numberOrNull(row.expected_pages), pageCount: numberOrNull(row.page_count),
    total: numberOrNull(row.total_rows), rowCount: numberOrNull(row.row_count),
    fields: parseJson(row.fields_json, []), pages: parseJson(row.pages_json, []),
    contentSha256: row.content_sha256, errorCode: row.error_code, error: row.error_message,
    startedAt: row.started_at, finishedAt: row.finished_at,
  };
}

export async function publishSearchBatch(db: DbAdapter, payload: unknown, options: PublishOptions = {}): Promise<Record<string, unknown>> {
  const batch = normalizeSearchBatch(payload);
  const rawRoot = path.resolve(options.rawRoot || process.env.SEARCH_ANALYTICS_RAW_DIR || "data/search-analytics/raw");
  const runId = String(batch.run.run_id);
  const stage = path.join(rawRoot, `.staging-${runId}-${process.pid}-${Date.now()}`);
  const finalDirectory = path.join(rawRoot, runId);
  let moved = false;
  try {
    if (!batch.failed) {
      await mkdir(stage, { recursive: true, mode: 0o700 });
      for (const page of batch.rawPages) {
        const file = path.join(stage, `page-${String(page.pageNumber).padStart(4, "0")}.json`);
        await writeFile(file, page.contents, { encoding: "utf8", mode: 0o600 });
      }
    }
    const execute = async (target: DbAdapter): Promise<Record<string, unknown>> => {
      if ((options.dialect || getAdapterType()) === "pg") await target.all("SELECT pg_advisory_xact_lock(hashtext(?))", ["ozon_search_analytics_publish"]);
      const existing = await target.all<Record<string, unknown>>("SELECT status,content_sha256,row_count FROM ozon_search_collection_runs WHERE run_id=?", [runId]);
      if (existing[0]) {
        if (existing[0].status !== batch.run.status || (existing[0].content_sha256 || null) !== (batch.run.content_sha256 || null)) {
          throw new SearchBatchError("runId already exists with different content", 409, "RUN_ID_CONFLICT");
        }
        if (!batch.failed) {
          const stored = await target.all<{ count: number | string }>("SELECT COUNT(*) AS count FROM ozon_search_query_snapshots WHERE run_id=?", [runId]);
          if (Number(stored[0]?.count) !== Number(existing[0].row_count)) throw new SearchBatchError("Existing batch storage is incomplete", 409, "EXISTING_BATCH_INCOMPLETE");
        }
        return { success: true, runId, status: batch.run.status, idempotent: true, rowCount: batch.snapshots.length };
      }
      await insertMany(target, "ozon_search_collection_runs", [batch.run], 1);
      if (!batch.failed) {
        await insertMany(target, "ozon_search_query_snapshots", batch.snapshots, 100);
        const rawRows = batch.rawPages.map(page => ({
          run_id: runId, page_number: page.pageNumber, request_json: page.requestJson,
          response_sha256: page.responseSha256, object_path: path.join(runId, `page-${String(page.pageNumber).padStart(4, "0")}.json`),
          parser_version: batch.manifest.parserVersion, server_date: page.serverDate,
        }));
        await insertMany(target, "ozon_search_raw_responses", rawRows, 50);
        await rename(stage, finalDirectory);
        moved = true;
        await refreshDerivedWindow(target, String(batch.run.company_id));
      }
      return { success: true, runId, status: batch.run.status, idempotent: false, rowCount: batch.snapshots.length, contentSha256: batch.run.content_sha256 };
    };
    if (!db.tx) throw new Error("Database transactions are required for search batch publishing");
    return await db.tx(execute);
  } catch (error) {
    if (moved) await rm(finalDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

export async function listSearchRuns(db: DbAdapter, companyId?: string, now = new Date()): Promise<Record<string, unknown>> {
  const rows = companyId
    ? await db.all<Record<string, unknown>>("SELECT * FROM ozon_search_collection_runs WHERE company_id=? ORDER BY started_at DESC LIMIT 100", [companyId])
    : await db.all<Record<string, unknown>>("SELECT * FROM ozon_search_collection_runs ORDER BY started_at DESC LIMIT 100");
  const items = rows.map(mapSearchRun);
  const lastAttempt = items[0] || null;
  const lastSuccess = items.find(item => item.status === "succeeded") || null;
  const successTime = lastSuccess?.anchorAt ? Date.parse(String(lastSuccess.anchorAt)) : NaN;
  return {
    items: items.slice(0, 30), lastAttempt, lastSuccess,
    stale: !lastSuccess || !Number.isFinite(successTime) || now.getTime() - successTime > 30 * 3_600_000,
    sourceDependency: "LOCAL_CHROME_ACTIVE_TAB_AND_LOGIN",
    note: "本机Chrome登录态和前台标签页是采集依赖；最近失败不会覆盖最近成功批次",
  };
}

async function latestRun(db: DbAdapter, companyId?: string, runId?: string): Promise<Record<string, unknown> | undefined> {
  if (runId) {
    const rows = await db.all<Record<string, unknown>>("SELECT * FROM ozon_search_collection_runs WHERE run_id=? AND status='succeeded'", [runId]);
    return rows[0];
  }
  const rows = companyId
    ? await db.all<Record<string, unknown>>("SELECT * FROM ozon_search_collection_runs WHERE company_id=? AND status='succeeded' ORDER BY anchor_at DESC LIMIT 1", [companyId])
    : await db.all<Record<string, unknown>>("SELECT * FROM ozon_search_collection_runs WHERE status='succeeded' ORDER BY anchor_at DESC LIMIT 1");
  return rows[0];
}

const SORT_COLUMNS: Record<string, string> = {
  query: "query_text", count: "search_popularity", uniqQueriesWCa: "cart_additions", ca: "cart_conversion_pct",
  ord: "unique_buyers", searchUsersToOrdUsers: "order_conversion_pct", gmv: "ordered_revenue_rub",
  avgCaRub: "average_price_rub", itemsViews: "shown_items_count", uniqSellers: "competitor_sellers_count",
  usersWithoutInterectionCount: "no_action_queries", usersWithoutInterectionShare: "no_action_share_pct",
  softQueryCount: "similar_queries", softQueryShare: "similar_share_pct", zrCount: "no_result_queries", zrShare: "no_result_share_pct",
};

export type QueryOptions = {
  companyId?: string; runId?: string; window?: string; query?: string;
  page?: number; pageSize?: number; sort?: string; direction?: string;
};

function paging(options: QueryOptions): { page: number; pageSize: number; sort: string; direction: "ASC" | "DESC" } {
  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? 50;
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new SearchBatchError("Invalid page or pageSize");
  const sort = SORT_COLUMNS[options.sort || "count"];
  if (!sort) throw new SearchBatchError("Unsupported sort field");
  const direction = (options.direction || "desc").toUpperCase();
  if (direction !== "ASC" && direction !== "DESC") throw new SearchBatchError("Unsupported sort direction");
  return { page, pageSize, sort, direction };
}

function likeQuery(value: string): string {
  return `%${value.trim().toLocaleLowerCase("ru-RU").replace(/[\\%_]/g, character => `\\${character}`).replace(/\s+/g, " ")}%`;
}

export async function querySearchSnapshots(db: DbAdapter, options: QueryOptions): Promise<Record<string, unknown>> {
  if (options.window === "28") {
    const latest = await latestRun(db, options.companyId);
    if (!latest) return { window: 28, items: [], total: 0, coverageStatus: "no_data", sourceRunIds: [] };
    return getDerivedWindow(db, String(latest.company_id));
  }
  if (options.window && options.window !== "7") throw new SearchBatchError("window must be 7 or 28");
  const { page, pageSize, sort, direction } = paging(options);
  const run = await latestRun(db, options.companyId, options.runId);
  if (!run) return { window: 7, items: [], total: 0, page, pageSize, run: null, sourceType: "native_7d" };
  const params: unknown[] = [run.run_id];
  let where = "run_id=?";
  if (options.query?.trim()) {
    where += " AND normalized_query LIKE ? ESCAPE '\\'";
    params.push(likeQuery(options.query));
  }
  const totalRows = await db.all<{ count: number | string }>(`SELECT COUNT(*) AS count FROM ozon_search_query_snapshots WHERE ${where}`, params);
  const tieBreaker = sort === "search_popularity" ? "page_number ASC, row_number ASC" : "query_text ASC";
  const rows = await db.all<Record<string, unknown>>(
    `SELECT * FROM ozon_search_query_snapshots WHERE ${where} ORDER BY ${sort} ${direction}, ${tieBreaker} LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return {
    window: 7, sourceType: "native_7d", dataScope: "seller_market_queries_not_store_sku_funnel",
    run: mapSearchRun(run), items: rows.map(row => ({
      query: row.query_text,
      ...Object.fromEntries(Object.entries(SORT_COLUMNS).filter(([field]) => field !== "query").map(([field, column]) => [field, numberOrNull(row[column])])),
      dynamic28: numberOrNull(row.dynamic_28_pct), dynamic7: numberOrNull(row.dynamic_7_pct),
      trendForYear: parseJson(row.seasonality_json, null), rawMetrics: parseJson(row.metrics_json, {}),
      collectedAt: row.collected_at, sourceRunId: row.run_id,
    })),
    total: Number(totalRows[0]?.count || 0), page, pageSize,
    metricDefinitionVersion: "native-search-v2-2026-11-09",
    note: "动态28/动态7未返回时保持NULL；这里不是本店SKU订单漏斗，缺失不能当作0",
  };
}

export async function getSearchTrend(db: DbAdapter, query: string, companyId?: string, days = 90): Promise<Record<string, unknown>> {
  if (!query.trim() || query.length > 2000 || !Number.isInteger(days) || days < 7 || days > 730) throw new SearchBatchError("Invalid trend query or days");
  const latest = await latestRun(db, companyId);
  if (!latest) return { query, items: [], note: "暂无原生快照" };
  const rows = await db.all<Record<string, unknown>>(
    `SELECT * FROM ozon_search_query_snapshots WHERE company_id=? AND normalized_query=? AND collected_at>=? ORDER BY collected_at ASC LIMIT 500`,
    [latest.company_id, query.trim().toLocaleLowerCase("ru-RU").replace(/\s+/g, " "), new Date(Date.now() - days * 86_400_000).toISOString()],
  );
  let previous = 0;
  return {
    query, sourceType: "native_7d_time_series", items: rows.map(row => {
      const timestamp = Date.parse(String(row.collected_at));
      const overlapsPrevious = previous > 0 && timestamp - previous < 7 * 86_400_000;
      previous = timestamp;
      return { runId: row.run_id, collectedAt: row.collected_at, metrics: parseJson(row.metrics_json, {}), dynamic28: null, dynamic7: null, overlapsPrevious };
    }),
    note: "相邻7天滚动快照可能重叠6天，趋势点不是独立新增事件；28天也不足以证明季节性",
  };
}
