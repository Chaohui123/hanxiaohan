import { timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { Router, type Request, type Response } from "express";
import express from "express";
import { getDb, type DbAdapter } from "../db/connection.js";
import { SearchBatchError } from "../services/search-analytics/batch.js";
import { SEARCH_METRICS, SEARCH_METRIC_DEFINITION_VERSION } from "../services/search-analytics/metric-definitions.js";
import { getSearchTrend, listSearchRuns, publishSearchBatch, querySearchSnapshots, type QueryOptions } from "../services/search-analytics/store.js";
import { emitEvent } from "../services/notification-events.js";

function validIngestKey(provided: string): boolean {
  const expected = process.env.SEARCH_ANALYTICS_INGEST_KEY || "";
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function optionsFrom(req: Request): QueryOptions {
  const integer = (value: unknown, fallback: number): number => value === undefined ? fallback : Number(value);
  return {
    companyId: req.query.companyId ? String(req.query.companyId) : undefined,
    runId: req.query.runId ? String(req.query.runId) : undefined,
    window: req.query.window ? String(req.query.window) : "7",
    query: req.query.query ? String(req.query.query) : undefined,
    page: integer(req.query.page, 1), pageSize: integer(req.query.pageSize, 50),
    sort: req.query.sort ? String(req.query.sort) : "count",
    direction: req.query.direction ? String(req.query.direction) : "desc",
  };
}

function applyDerivedPaging(result: Record<string, unknown>, options: QueryOptions): Record<string, unknown> {
  if (result.coverageStatus !== "complete") return { ...result, page: options.page || 1, pageSize: options.pageSize || 50 };
  const search = (options.query || "").trim().toLocaleLowerCase("ru-RU");
  const page = options.page || 1;
  const pageSize = options.pageSize || 50;
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new SearchBatchError("Invalid page or pageSize");
  const sort = options.sort || "count";
  if (sort !== "query" && !SEARCH_METRICS.some(metric => metric.field === sort)) throw new SearchBatchError("Unsupported sort field");
  const direction = options.direction === "asc" ? 1 : -1;
  const filtered = (result.items as Array<Record<string, unknown>>).filter(item => String(item.query).toLocaleLowerCase("ru-RU").includes(search));
  filtered.sort((a, b) => {
    if (sort === "query") return String(a.query).localeCompare(String(b.query), "ru") * direction;
    const aValue = ((a.metrics as Record<string, { value: number | null }>)[sort]?.value ?? null);
    const bValue = ((b.metrics as Record<string, { value: number | null }>)[sort]?.value ?? null);
    if (aValue === null && bValue === null) return String(a.query).localeCompare(String(b.query), "ru");
    if (aValue === null) return 1;
    if (bValue === null) return -1;
    return (aValue - bValue) * direction || String(a.query).localeCompare(String(b.query), "ru");
  });
  return { ...result, total: filtered.length, page, pageSize, items: filtered.slice((page - 1) * pageSize, page * pageSize) };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

async function exportSearch(res: Response, db: DbAdapter, options: QueryOptions, format: string): Promise<void> {
  const window = options.window === "28" ? 28 : 7;
  let items: Array<Record<string, unknown>> = [];
  let metadata: Record<string, unknown> = {};
  if (window === 7) {
    const first = await querySearchSnapshots(db, { ...options, page: 1, pageSize: 200 });
    const pages = Math.ceil(Number(first.total) / 200);
    const all = [first];
    for (let page = 2; page <= pages; page++) all.push(await querySearchSnapshots(db, { ...options, page, pageSize: 200 }));
    items = all.flatMap(result => result.items as Array<Record<string, unknown>>);
    const run = first.run as Record<string, unknown> | null | undefined;
    metadata = {
      run: run ? { runId: run.runId, companyId: run.companyId, nativePeriod: run.nativePeriod, anchorAt: run.anchorAt, pageCount: run.pageCount, rowCount: run.rowCount, contentSha256: run.contentSha256 } : null,
      sourceType: first.sourceType, metricDefinitionVersion: first.metricDefinitionVersion,
    };
  } else {
    const result = await querySearchSnapshots(db, { ...options, window: "28" });
    const search = (options.query || "").trim().toLocaleLowerCase("ru-RU");
    items = (result.items as Array<Record<string, unknown>>).filter(item => String(item.query).toLocaleLowerCase("ru-RU").includes(search));
    metadata = { sourceType: result.sourceType, coverageStatus: result.coverageStatus, coverageDays: result.coverageDays, sourceRunIds: result.sourceRunIds, windowBasis: result.windowBasis, algorithmVersion: result.algorithmVersion, reason: result.reason };
  }
  const fields = ["query", ...SEARCH_METRICS.map(metric => metric.field)];
  const rows = items.map(item => Object.fromEntries(fields.map(field => {
    if (field === "query") return [field, item.query];
    return [field, window === 7 ? (item.rawMetrics as Record<string, unknown>)?.[field] ?? null : (item.metrics as Record<string, { value: unknown }>)?.[field]?.value ?? null];
  })));
  const filename = `ozon-search-${window}d-${Date.now()}.${format}`;
  if (format === "csv") {
    const notes = Object.entries(metadata).map(([key, value]) => [`# ${key}`, typeof value === "string" ? value : JSON.stringify(value)]);
    const lines = [...notes, fields, ...rows.map(row => fields.map(field => row[field]))];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(`\ufeff${lines.map(row => row.map(csvCell).join(",")).join("\r\n")}\r\n`);
    return;
  }
  if (format !== "xlsx") throw new SearchBatchError("format must be csv or xlsx");
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows, { header: fields }), "search_queries");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
    { item: "source", value: "Ozon Seller原生市场查询；不等于本店SKU经营漏斗" },
    { item: "window", value: window === 7 ? "原生7天" : "四个原生7天窗口的自建28天；不是官方28天去重口径" },
    { item: "null", value: "空值、会员未返回和不可计算均保持为空，不等于0；独立买家不跨周相加" },
    ...Object.entries(metadata).map(([key, value]) => ({ item: key, value: JSON.stringify(value) })),
  ]), "README");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
}

export function createSearchAnalyticsRouter(): Router {
  const router = Router();
  router.post("/search-analytics/ingest", express.raw({ type: ["application/gzip", "application/octet-stream"], limit: "25mb" }), async (req, res) => {
    if (!process.env.SEARCH_ANALYTICS_INGEST_KEY) { res.status(503).json({ success: false, error: "Search ingest is not configured" }); return; }
    if (!validIngestKey(String(req.headers["x-search-ingest-key"] || ""))) { res.status(401).json({ success: false, error: "Invalid search ingest key" }); return; }
    try {
      if (!Buffer.isBuffer(req.body)) { res.status(400).json({ success: false, error: "gzip batch body is required" }); return; }
      const text = gunzipSync(req.body, { maxOutputLength: 64 * 1024 * 1024 }).toString("utf8");
      const payload = JSON.parse(text);
      const db = await getDb();
      if (!db) { res.status(503).json({ success: false, error: "DB unavailable" }); return; }
      const result = await publishSearchBatch(db, payload);
      if (result.status === "failed") {
        const manifest = (payload as { manifest?: { errorCode?: string; runId?: string } }).manifest;
        await emitEvent("SEARCH_ANALYTICS_FAILED", { errorCode: manifest?.errorCode || "COLLECTION_FAILED", runId: manifest?.runId || "unknown" }).catch(() => {});
      }
      res.json(result);
    } catch (error) {
      const status = error instanceof SearchBatchError ? error.statusCode : 500;
      res.status(status).json({ success: false, error: (error as Error).message });
    }
  });

  router.get("/search-analytics/metrics", (_req, res) => {
    res.json({ version: SEARCH_METRIC_DEFINITION_VERSION, items: SEARCH_METRICS, note: "所有未验证跨周口径的指标仅保留原生周值和趋势，不自动求和或平均" });
  });
  router.get("/search-analytics/runs", async (req, res) => {
    try {
      const db = await getDb();
      if (!db) { res.status(503).json({ success: false, error: "DB unavailable" }); return; }
      res.json(await listSearchRuns(db, req.query.companyId ? String(req.query.companyId) : undefined));
    } catch (error) { res.status(500).json({ success: false, error: (error as Error).message }); }
  });
  router.get("/search-analytics/queries/trend", async (req, res) => {
    try {
      const db = await getDb();
      if (!db) { res.status(503).json({ success: false, error: "DB unavailable" }); return; }
      const days = req.query.days === undefined ? 90 : Number(req.query.days);
      res.json(await getSearchTrend(db, String(req.query.query || ""), req.query.companyId ? String(req.query.companyId) : undefined, days));
    } catch (error) { res.status(error instanceof SearchBatchError ? 400 : 500).json({ success: false, error: (error as Error).message }); }
  });
  router.get("/search-analytics/queries", async (req, res) => {
    try {
      const options = optionsFrom(req);
      const db = await getDb();
      if (!db) { res.status(503).json({ success: false, error: "DB unavailable" }); return; }
      const result = await querySearchSnapshots(db, options);
      res.json(options.window === "28" ? applyDerivedPaging(result, options) : result);
    } catch (error) { res.status(error instanceof SearchBatchError ? error.statusCode : 500).json({ success: false, error: (error as Error).message }); }
  });
  router.get("/search-analytics/export", async (req, res) => {
    try {
      const db = await getDb();
      if (!db) { res.status(503).json({ success: false, error: "DB unavailable" }); return; }
      const options = optionsFrom(req);
      await exportSearch(res, db, options, String(req.query.format || "xlsx"));
    } catch (error) {
      if (!res.headersSent) res.status(error instanceof SearchBatchError ? error.statusCode : 500).json({ success: false, error: (error as Error).message });
    }
  });
  return router;
}
