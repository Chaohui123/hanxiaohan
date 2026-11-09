import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import express from "express";
import request from "supertest";
import { createSqliteTestDb, type SqliteTestDb } from "./helpers/test-db.js";
import { SEARCH_ANALYTICS_DDL } from "../src/db/search-analytics-schema.js";
import { normalizeSearchBatch, type SearchBatch } from "../src/services/search-analytics/batch.js";
import { getSearchTrend, listSearchRuns, publishSearchBatch, querySearchSnapshots } from "../src/services/search-analytics/store.js";
import { refreshDerivedWindow, selectWeeklyRuns } from "../src/services/search-analytics/derived-windows.js";
import { createSearchAnalyticsRouter } from "../src/routes/search-analytics.route.js";

vi.mock("../src/db/connection.js", () => ({ getDb: async () => context.adapter, getAdapterType: () => "sqlite" }));
vi.mock("../src/services/notification-events.js", () => ({ emitEvent: vi.fn(async () => {}) }));

let context: SqliteTestDb;
let rawRoot: string;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function searchRow(query = "телефон", popularity = 100): Record<string, unknown> {
  return {
    query, count: popularity, uniqQueriesWCa: 10, ca: 10, ord: 3, searchUsersToOrdUsers: 3,
    gmv: 1000, avgCaRub: 500, itemsViews: 12, uniqSellers: 5,
    usersWithoutInterectionCount: 20, usersWithoutInterectionShare: 20,
    softQueryCount: 1, softQueryShare: 0.5, zrCount: 2, zrShare: 1,
    trendForYear: [], avgCountItems: 0,
  };
}

function makeBatch(rows = [searchRow()], options: { runId?: string; anchor?: string; companyId?: string } = {}): SearchBatch {
  const anchor = options.anchor || new Date().toISOString();
  const pages = Array.from({ length: Math.ceil(rows.length / 50) }, (_, index) => rows.slice(index * 50, index * 50 + 50));
  const rawPages = pages.map((items, index) => {
    const requestBody = { text: "", limit: "50", offset: String(index * 50), sort_by: "count" as const, sort_dir: "desc" as const, period: "days_7" as const };
    const rawBody = JSON.stringify({ data: items, offset: String(index * 50), total: String(rows.length) });
    return {
      request: requestBody, httpStatus: 200 as const, serverDate: anchor, contentType: "application/json",
      requestHeaderNames: ["content-type", "x-o3-company-id"], responseSha256: sha256(rawBody), rawBody,
    };
  });
  const contentSha256 = sha256(rawPages.map(page => page.responseSha256).join("\n"));
  return {
    manifest: {
      runId: options.runId || `test-${randomUUID()}`, collectorVersion: "test", parserVersion: "v1",
      startedAt: new Date(Date.parse(anchor) - 1000).toISOString(), finishedAt: anchor,
      status: "COLLECTED", complete: true, sourceType: "ozon_seller_ui_native_query_report", sourceDependency: "LOCAL_CHROME_ACTIVE_TAB_AND_LOGIN",
      companyId: options.companyId || "5140601",
      nativePeriod: { requested: "days_7", label: "时期: 7 天", start: null, end: null, timezone: null },
      filters: { text: "", sort_by: "count", sort_dir: "desc", period: "days_7" },
      expectedPages: pages.length, pageCount: pages.length, total: rows.length, rowCount: rows.length,
      coverage: "OBSERVED_QUERY_SET_NOT_UNLIMITED_MARKET", fields: Object.keys(rows[0] || searchRow()).sort(),
      pages: rawPages.map((page, index) => ({ page: index + 1, offset: index * 50, rows: pages[index].length, serverDate: anchor, responseSha256: page.responseSha256 })),
      contentSha256,
    },
    pages: rawPages,
  };
}

function failedBatch(source: SearchBatch): SearchBatch {
  return {
    manifest: {
      ...source.manifest, runId: `failed-${randomUUID()}`, status: "FAILED", complete: false,
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      expectedPages: 0, pageCount: 0, total: 0, rowCount: 0, fields: [], pages: [], contentSha256: null,
      errorCode: "SESSION_EXPIRED", error: "Seller login required",
    },
    pages: [],
  };
}

beforeEach(async () => {
  context = createSqliteTestDb();
  await context.adapter.exec(SEARCH_ANALYTICS_DDL);
  context.adapter.tx = async callback => {
    context.db.exec("BEGIN IMMEDIATE");
    try { const value = await callback(context.adapter); context.db.exec("COMMIT"); return value; }
    catch (error) { context.db.exec("ROLLBACK"); throw error; }
  };
  rawRoot = await mkdtemp(path.join("temp", "search-analytics-test-"));
  process.env.SEARCH_ANALYTICS_INGEST_KEY = "unit-test-ingest-key";
});

afterEach(async () => {
  context.close();
  await rm(rawRoot, { recursive: true, force: true });
  delete process.env.SEARCH_ANALYTICS_INGEST_KEY;
});

describe("search batch validation", () => {
  it("maps verified UI fields without inventing dynamic values", () => {
    const result = normalizeSearchBatch(makeBatch());
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]).toMatchObject({ query_text: "телефон", unique_buyers: 3, shown_items_count: 12, dynamic_28_pct: null, dynamic_7_pct: null });
    expect(JSON.parse(String(result.snapshots[0].metrics_json))).toMatchObject({ avgCountItems: 0, trendForYear: [] });
  });

  it("rejects duplicate queries across page boundaries", () => {
    const rows = Array.from({ length: 50 }, (_, index) => searchRow(`запрос ${index}`));
    rows.push(searchRow("запрос 0"));
    expect(() => normalizeSearchBatch(makeBatch(rows))).toThrow("Duplicate query");
  });

  it("rejects altered raw evidence, missing pages and request headers", () => {
    const changed = makeBatch();
    changed.pages[0].rawBody = changed.pages[0].rawBody.replace("телефон", "другой");
    expect(() => normalizeSearchBatch(changed)).toThrow("hash");
    const missing = makeBatch();
    missing.pages = [];
    expect(() => normalizeSearchBatch(missing)).toThrow("Page count");
    const sensitive = makeBatch() as SearchBatch & { pages: Array<Record<string, unknown>> };
    sensitive.pages[0].requestHeaders = { cookie: "must-not-be-persisted" };
    expect(() => normalizeSearchBatch(sensitive)).toThrow("sanitized");
  });

  it("rejects a login HTML response instead of treating it as zero queries", () => {
    const batch = makeBatch();
    batch.pages[0].rawBody = "<html>Login</html>";
    expect(() => normalizeSearchBatch(batch)).toThrow();
  });
});

describe("SQLite storage and read API", () => {
  it("publishes atomically and replays the same run idempotently", async () => {
    const batch = makeBatch();
    const first = await publishSearchBatch(context.adapter, batch, { rawRoot, dialect: "sqlite" });
    const second = await publishSearchBatch(context.adapter, batch, { rawRoot, dialect: "sqlite" });
    expect(first).toMatchObject({ status: "succeeded", rowCount: 1, idempotent: false });
    expect(second).toMatchObject({ status: "succeeded", rowCount: 1, idempotent: true });
    expect(context.db.prepare("SELECT COUNT(*) AS count FROM ozon_search_query_snapshots").get()).toEqual({ count: 1 });
    expect(context.db.prepare("SELECT COUNT(*) AS count FROM ozon_search_raw_responses").get()).toEqual({ count: 1 });
    const stored = await readFile(path.join(rawRoot, batch.manifest.runId, "page-0001.json"), "utf8");
    expect(stored).not.toContain("must-not-be-persisted");
    expect(stored).not.toContain("cookie");
    const result = await querySearchSnapshots(context.adapter, { window: "7" });
    expect(result.total).toBe(1);
    expect(result.items).toMatchObject([{ query: "телефон", ord: 3, dynamic28: null, dynamic7: null }]);
    expect(await querySearchSnapshots(context.adapter, { window: "28" })).toMatchObject({ coverageStatus: "insufficient_history", coverageDays: 7 });
  });

  it("preserves native page order for equal popularity values", async () => {
    const rows = [searchRow("я последний по алфавиту"), searchRow("а первый по алфавиту")];
    await publishSearchBatch(context.adapter, makeBatch(rows), { rawRoot, dialect: "sqlite" });
    const result = await querySearchSnapshots(context.adapter, { window: "7", sort: "count", direction: "desc" });
    expect(result.items).toMatchObject([{ query: rows[0].query }, { query: rows[1].query }]);
  });

  it("rolls back a failed page and records a failed attempt without replacing success", async () => {
    const valid = makeBatch();
    await publishSearchBatch(context.adapter, valid, { rawRoot, dialect: "sqlite" });
    const invalid = makeBatch();
    invalid.manifest.contentSha256 = "0".repeat(64);
    await expect(publishSearchBatch(context.adapter, invalid, { rawRoot, dialect: "sqlite" })).rejects.toThrow();
    expect(context.db.prepare("SELECT COUNT(*) AS count FROM ozon_search_collection_runs WHERE run_id=?").get(invalid.manifest.runId)).toEqual({ count: 0 });
    await publishSearchBatch(context.adapter, failedBatch(valid), { rawRoot, dialect: "sqlite" });
    const health = await listSearchRuns(context.adapter);
    expect(health.lastAttempt).toMatchObject({ status: "failed", errorCode: "SESSION_EXPIRED" });
    expect(health.lastSuccess).toMatchObject({ runId: valid.manifest.runId, rowCount: 1 });
    expect((await querySearchSnapshots(context.adapter, {})).total).toBe(1);
  });

  it("rejects a conflicting runId and supports exact trend and literal search", async () => {
    const batch = makeBatch([searchRow("100% универсальный")]);
    await publishSearchBatch(context.adapter, batch, { rawRoot, dialect: "sqlite" });
    const conflict = makeBatch([searchRow("другой")], { runId: batch.manifest.runId });
    await expect(publishSearchBatch(context.adapter, conflict, { rawRoot, dialect: "sqlite" })).rejects.toMatchObject({ statusCode: 409 });
    expect((await querySearchSnapshots(context.adapter, { query: "%" })).total).toBe(1);
    expect((await querySearchSnapshots(context.adapter, { query: "не существует" })).total).toBe(0);
    expect((await getSearchTrend(context.adapter, "100% универсальный")).items).toHaveLength(1);
  });
});

describe("non-overlapping derived windows", () => {
  it("does not sum adjacent daily rolling reports or accept a missing week", () => {
    const run = (day: number): { run_id: string; company_id: string; filter_hash: string; native_period: string; anchor_at: string } => ({
      run_id: `run-${day}`, company_id: "5140601", filter_hash: "same", native_period: "days_7",
      anchor_at: new Date(Date.UTC(2026, 10, day, 4)).toISOString(),
    });
    expect(selectWeeklyRuns([run(1), run(2), run(3), run(4)], "5140601", "same").coverageStatus).toBe("insufficient_history");
    expect(selectWeeklyRuns([run(1), run(8), run(16), run(23), run(30)], "5140601", "same").coverageStatus).toBe("insufficient_history");
    expect(selectWeeklyRuns([run(1), run(8), run(15), run(22), run(29)], "5140601", "same").coverageStatus).toBe("complete");
    expect(selectWeeklyRuns([run(1), { ...run(8), filter_hash: "changed" }, run(15), run(22), run(29)], "5140601", "same").coverageStatus).toBe("insufficient_history");
  });

  it("keeps unique buyers unaggregated and preserves absent queries as unknown", async () => {
    const anchors = [0, 7, 14, 21].map(days => new Date(Date.now() - days * 86_400_000).toISOString());
    for (const [index, anchor] of anchors.entries()) {
      const rows = [searchRow("телефон", 100 + index * 10)];
      if (index === 3) rows.push(searchRow("только старая неделя", 10));
      await publishSearchBatch(context.adapter, makeBatch(rows, { anchor, runId: `week-${index}` }), { rawRoot, dialect: "sqlite" });
    }
    const result = await refreshDerivedWindow(context.adapter, "5140601");
    expect(result).toMatchObject({ coverageStatus: "complete", coverageDays: 28, total: 2 });
    const row = (result.items as Array<Record<string, unknown>>).find(item => item.query === "телефон") as { metrics: Record<string, { value: number | null; weeklyValues: Array<{ value: number | null }> }> };
    expect(row.metrics.ord.value).toBeNull();
    expect(row.metrics.ord.weeklyValues.map(item => item.value)).toEqual([3, 3, 3, 3]);
    expect(row.metrics.count.value).toBe(100);
    expect(row.metrics.gmv.value).toBe(1000);
    expect(row.metrics.dynamic28.value).toBeNull();
    expect(context.db.prepare("SELECT COUNT(*) AS count FROM ozon_search_derived_windows").get()).toEqual({ count: 2 });
    const missing = (result.items as Array<Record<string, unknown>>).find(item => item.query === "только старая неделя") as { metrics: Record<string, { value: number | null }> };
    expect(missing.metrics.count.value).toBeNull();
  });
});

describe("authenticated HTTP endpoints", () => {
  it("requires a separate ingest key and serves real queries, runs, trends and exports", async () => {
    const app = express();
    app.use("/api", createSearchAnalyticsRouter());
    const batch = makeBatch();
    delete process.env.SEARCH_ANALYTICS_INGEST_KEY;
    await request(app).post("/api/search-analytics/ingest").expect(503);
    process.env.SEARCH_ANALYTICS_INGEST_KEY = "unit-test-ingest-key";
    await request(app).post("/api/search-analytics/ingest").set("X-Search-Ingest-Key", "wrong").expect(401);
    const body = gzipSync(JSON.stringify(batch));
    await request(app).post("/api/search-analytics/ingest").set("Content-Type", "application/gzip").set("X-Search-Ingest-Key", "unit-test-ingest-key").send(body).expect(200);
    const queries = await request(app).get("/api/search-analytics/queries?window=7&pageSize=50").expect(200);
    expect(queries.body).toMatchObject({ total: 1, items: [{ query: "телефон", dynamic28: null }] });
    const runs = await request(app).get("/api/search-analytics/runs").expect(200);
    expect(runs.body.lastSuccess.runId).toBe(batch.manifest.runId);
    await request(app).get("/api/search-analytics/queries/trend?query=телефон").expect(200).expect(response => expect(response.body.items).toHaveLength(1));
    await request(app).get("/api/search-analytics/queries?window=28").expect(200).expect(response => expect(response.body.coverageStatus).toBe("insufficient_history"));
    const csv = await request(app).get("/api/search-analytics/export?format=csv").expect(200);
    expect(csv.text).toContain("телефон");
    expect(csv.headers["content-type"]).toContain("text/csv");
    const xlsx = await request(app).get("/api/search-analytics/export?format=xlsx").buffer().parse((response, callback) => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => callback(null, Buffer.concat(chunks)));
    }).expect(200);
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(xlsx.body, { type: "buffer" });
    expect(workbook.SheetNames).toEqual(["search_queries", "README"]);
    expect(XLSX.utils.sheet_to_json(workbook.Sheets.search_queries)).toMatchObject([{ query: "телефон", ord: 3 }]);
  });
});
