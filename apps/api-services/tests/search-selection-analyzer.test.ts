import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import request from "supertest";
import { createSqliteTestDb, type SqliteTestDb } from "./helpers/test-db.js";
import { SEARCH_ANALYTICS_DDL } from "../src/db/search-analytics-schema.js";
import type { SearchBatch } from "../src/services/search-analytics/batch.js";
import { publishSearchBatch } from "../src/services/search-analytics/store.js";
import {
  analyzeSearchSelection, analyzeSelectionRows, combineOpportunityScore, linearQuantile, loadSelectionConfig,
  scaleRobust, SelectionAnalysisError, type RuntimeSelectionConfig,
} from "../src/services/search-analytics/selection-analyzer.js";
import { createSearchAnalyticsRouter } from "../src/routes/search-analytics.route.js";
import { buildSelectionWorkbook } from "../src/services/search-analytics/selection-export.js";

vi.mock("../src/db/connection.js", () => ({ getDb: async () => context.adapter, getAdapterType: () => "sqlite" }));
vi.mock("../src/services/notification-events.js", () => ({ emitEvent: vi.fn(async () => {}) }));

let context: SqliteTestDb;
let rawRoot: string;
let config: RuntimeSelectionConfig;
const configRoot = path.resolve("tools");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const FULL_METRICS = {
  count: 10000, uniqQueriesWCa: 120, ca: 40, ord: 350, searchUsersToOrdUsers: 12,
  gmv: 900000, avgCaRub: 3000, itemsViews: 8, uniqSellers: 10,
  usersWithoutInterectionCount: 50, usersWithoutInterectionShare: 50,
  zrCount: 3, zrShare: 2.5, dynamic7: null, dynamic28: null,
};
function searchRow(query = "органайзер для хранения", changes: Record<string, unknown> = {}): Record<string, unknown> {
  return { query, ...FULL_METRICS, ...changes };
}
function makeBatch(rows = [searchRow()], options: { runId?: string; anchor?: string } = {}): SearchBatch {
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
  return {
    manifest: {
      runId: options.runId || `selection-${randomUUID()}`, collectorVersion: "test", parserVersion: "v1",
      startedAt: new Date(Date.parse(anchor) - 1000).toISOString(), finishedAt: anchor,
      status: "COLLECTED", complete: true, sourceType: "ozon_seller_ui_native_query_report", sourceDependency: "LOCAL_CHROME_ACTIVE_TAB_AND_LOGIN",
      companyId: "5140601", nativePeriod: { requested: "days_7", label: "7天", start: null, end: null, timezone: null },
      filters: { text: "", sort_by: "count", sort_dir: "desc", period: "days_7" },
      expectedPages: pages.length, pageCount: pages.length, total: rows.length, rowCount: rows.length,
      coverage: "OBSERVED_QUERY_SET_NOT_UNLIMITED_MARKET", fields: Object.keys(rows[0] || searchRow()).sort(),
      pages: rawPages.map((page, index) => ({ page: index + 1, offset: index * 50, rows: pages[index].length, serverDate: anchor, responseSha256: page.responseSha256 })),
      contentSha256: sha256(rawPages.map(page => page.responseSha256).join("\n")),
    },
    pages: rawPages,
  };
}
function failedBatch(source: SearchBatch): SearchBatch {
  return { manifest: {
    ...source.manifest, runId: `failed-${randomUUID()}`, status: "FAILED", complete: false,
    expectedPages: 0, pageCount: 0, total: 0, rowCount: 0, fields: [], pages: [], contentSha256: null,
    errorCode: "SESSION_EXPIRED", error: "Seller login required",
  }, pages: [] };
}
function analyze(rows: Array<Record<string, unknown>>, runId = "pure-run") {
  return analyzeSelectionRows(rows, config, { runId, anchorAt: "2026-11-14T00:00:00Z", hash: "a".repeat(64), rowCount: rows.length });
}
function byQuery(rows: Array<Record<string, unknown>>): Map<string, Record<string, unknown>> {
  return new Map(rows.map(row => [String(row.query), row]));
}

beforeEach(async () => {
  context = createSqliteTestDb();
  await context.adapter.exec(SEARCH_ANALYTICS_DDL);
  context.adapter.tx = async callback => {
    context.db.exec("BEGIN IMMEDIATE");
    try { const value = await callback(context.adapter); context.db.exec("COMMIT"); return value; }
    catch (error) { context.db.exec("ROLLBACK"); throw error; }
  };
  rawRoot = await mkdtemp(path.join("temp", "search-selection-test-"));
  config = loadSelectionConfig({ root: configRoot });
});

afterEach(async () => {
  context.close();
  await rm(rawRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("selection scoring primitives", () => {
  it("uses linear quantiles, log1p anchors, caps and collapsed scores", () => {
    expect(linearQuantile([0, 10], 0.05)).toBe(0.5);
    expect(linearQuantile([0, 10, 20, 30], 0.5)).toBe(15);
    const logged = scaleRobust([0, 9, 99], [0, 1], { logTransform: true });
    expect(logged.metadata.lowerAnchor).toBe(0);
    expect(logged.metadata.upperAnchor).toBe(Math.log1p(99));
    expect(logged.metadata.upperAnchorRaw).toBeCloseTo(99);
    expect(logged.scores).toEqual([0, Math.log(10) / Math.log(100), 1]);
    const capped = scaleRobust([10, 85, 100], [0, 1], { upperAnchorCap: 85 });
    expect(capped.metadata.upperAnchor).toBe(85);
    expect(capped.scores).toEqual([0, 1, 1]);
    const collapsed = scaleRobust([5, 5], [0.05, 0.95], { logTransform: true });
    expect(collapsed.scores).toEqual([0.5, 0.5]);
    expect(collapsed.metadata.collapsedTo).toBe(0.5);
  });

  it("keeps fixed weights, partial normalization and the 0.65 boundary", () => {
    expect(combineOpportunityScore(0.8, 0.6, 0.4, 0.5)).toEqual({ score: 60, activeWeight: 1, status: "FULL_4D_RANKING_ONLY" });
    expect(combineOpportunityScore(0.8, 0.6, 0.4, null)).toEqual({ score: 61.11, activeWeight: 0.9, status: "PARTIAL_RENORMALIZED" });
    expect(combineOpportunityScore(0.8, 0.6, null, null)).toEqual({ score: 69.23, activeWeight: 0.65, status: "PARTIAL_RENORMALIZED" });
    expect(combineOpportunityScore(0.8, null, null, null)).toMatchObject({ score: null, activeWeight: 0.3, status: "INSUFFICIENT_METRICS" });
  });

  it("distinguishes NULL, true zero, no-cart price and extreme prices", () => {
    const result = analyze([
      searchRow("нулевой", { uniqQueriesWCa: 0, ca: 0, ord: 0, avgCaRub: 0 }),
      searchRow("пропуск", { avgCaRub: null }),
      searchRow("истинный ноль", { avgCaRub: 0 }),
      searchRow("экстрим", { avgCaRub: 100001 }),
    ]);
    const rows = byQuery(result.detail);
    expect(rows.get("нулевой")).toMatchObject({ avgCaRub: 0, avgCaRub_effective: null, price_obs_status: "UNOBSERVED_NO_CART", ca: 0, S_ca: 0 });
    expect(rows.get("пропуск")).toMatchObject({ avgCaRub: null, avgCaRub_effective: null, price_obs_status: "MISSING_NULL" });
    expect(rows.get("истинный ноль")).toMatchObject({ avgCaRub: 0, avgCaRub_effective: null, price_obs_status: "NON_POSITIVE_PRICE_UNOBSERVED" });
    expect(rows.get("экстрим")?.risk_flags).toContain("EXTREME_PRICE_OUTLIER");
    expect(rows.get("экстрим")?.S_price).toBe(0.5);
    expect(result.top30.some(row => row.query === "экстрим")).toBe(false);
    expect(result.detail.every(row => row.max_total_cost_rub_10pct === null && row.max_total_cost_rub_15pct === null)).toBe(true);
  });
});

describe("selection ordering, governance and gates", () => {
  it("deduplicates NFKC/lowercase/whitespace without summing and preserves original order", () => {
    const result = analyze([
      searchRow("Ａэрогриль  ", { count: 20000, ca: null }),
      searchRow("первый", { count: 9000 }),
      searchRow("aэрогриль", { count: 20000, ca: 20 }),
      searchRow("куртка зимняя женская"),
      searchRow("куртка женская зимняя", { count: 8000 }),
    ]);
    expect(result.manifest.filterFunnel).toMatchObject({ rawRows: 5, exactDuplicatesRemoved: 1, deduplicatedRows: 4, conservedRows: 5 });
    const grill = result.detail.find(row => row.query_norm === "aэрогриль");
    expect(grill).toMatchObject({ original_row_id: 4, count: 20000, ca: 20 });
    expect(result.quarantine[0]).toMatchObject({ isolation_type: "EXACT_DUPLICATE_REMOVED", kept_master_row_id: 4 });
    const coats = result.detail.filter(row => String(row.query).startsWith("куртка"));
    expect(coats.map(row => row.count)).toEqual([10000, 8000]);
    expect(coats[0].token_cluster_id).toBe(coats[1].token_cluster_id);
    expect(coats[0].cluster_size_in_batch).toBe(2);
  });

  it("reuses brand, existing, terminated and noise rules without bare-token false positives", () => {
    const productQueries = ["видеорегистратор", "видеокарта", "камера видеонаблюдения", "фотоаппарат", "фотобумага", "фоторамка", "ремонтные шипы", "пленка укрывная для ремонта", "рамка для фото"];
    const filteredQueries = ["Apple", "TPMS Chery", "ремня вариатора буран", "подогрев боковых зеркал", "зимнее термобельё для женщин", "органайзер своими руками", "ИКЕА"];
    const result = analyze([...productQueries, ...filteredQueries].map(query => searchRow(query)));
    expect(result.detail.map(row => row.query)).toEqual(productQueries);
    const filtered = byQuery(result.filtered);
    expect(filtered.get("Apple")?.filter_category).toBe("BRAND_IP_BLACKLIST");
    expect(filtered.get("TPMS Chery")?.filter_category).toBe("SHOP_EXISTING_SKU");
    expect(filtered.get("ремня вариатора буран")?.filter_category).toBe("SHOP_EXISTING_SKU");
    expect(filtered.get("подогрев боковых зеркал")?.filter_category).toBe("SHOP_TERMINATED_DIRECTION");
    expect(filtered.get("зимнее термобельё для женщин")?.filter_category).toBe("SHOP_TERMINATED_DIRECTION");
    expect(filtered.get("органайзер своими руками")?.filter_category).toBe("NON_PURCHASE_NOISE");
  });

  it("enforces commercial gates and manual identity flags without padding", () => {
    const result = analyze([
      searchRow("низкая ca", { ca: 14.99 }),
      searchRow("низкий ord", { searchUsersToOrdUsers: 1.99 }),
      searchRow("нет ca", { ca: null }),
      searchRow("омега"),
      searchRow("органайзер для хранения"),
    ]);
    const detail = byQuery(result.detail);
    expect(detail.get("низкая ca")?.top30_exclusion_reason).toBe("LOW_COMMERCIAL_INTENT");
    expect(detail.get("низкий ord")?.top30_exclusion_reason).toBe("LOW_COMMERCIAL_INTENT");
    expect(detail.get("нет ca")?.top30_exclusion_reason).toBe("MISSING_COMMERCIAL_INTENT");
    expect(detail.get("омега")).toMatchObject({ top30_eligible: false, top30_exclusion_reason: "MANUAL_IDENTITY_REVIEW", manual_review_flags: "AMBIGUOUS_IDENTITY|BRAND_REVIEW_REQUIRED" });
    expect(result.top30.map(row => row.query)).toEqual(["органайзер для хранения"]);
    expect(result.top30[0].cn_gloss_draft).toContain("待审");
    const empty = analyze([searchRow("обычный запрос", { count: 1000, ca: 5, ord: 1 })]);
    expect(empty.top30).toEqual([]);
    expect(empty.manifest.filterFunnel).toMatchObject({ top30Actual: 0, conservedRows: 1 });
  });

  it("records pre/post governance quantiles and scaling anchors", () => {
    const result = analyze([
      searchRow("alpha", { count: 1000 }), searchRow("beta", { count: 2000 }), searchRow("Apple", { count: 9000 }),
      searchRow(" alpha ", { count: 1000 }), searchRow("broken", { count: null }),
    ]);
    const manifest = result.manifest as Record<string, any>;
    expect(manifest.quantiles.count).toMatchObject({ present: 3, p50: 2000 });
    expect(manifest.eligibleQuantiles.count).toMatchObject({ present: 2, p50: 1500 });
    expect(manifest.scaling.heat.log1p).toBe(true);
    expect(manifest.scaling.price.upperAnchor).toBeLessThanOrEqual(Math.log1p(25000));
    expect(manifest.configuration.files.reviewOverrides.sha256).toHaveLength(64);
    expect(manifest.wordstat.status).toBe("NOT_REQUESTED");
  });

  it("supports SEARCH_SELECTION_CONFIG_ROOT", () => {
    const previous = process.env.SEARCH_SELECTION_CONFIG_ROOT;
    process.env.SEARCH_SELECTION_CONFIG_ROOT = configRoot;
    try { expect(loadSelectionConfig().configSha256).toBe(config.configSha256); }
    finally {
      if (previous === undefined) delete process.env.SEARCH_SELECTION_CONFIG_ROOT;
      else process.env.SEARCH_SELECTION_CONFIG_ROOT = previous;
    }
  });

  it("fails closed for missing or malformed review overrides", async () => {
    expect(() => loadSelectionConfig({ root: configRoot, reviewOverridesPath: path.join(rawRoot, "missing.yaml") })).toThrow(SelectionAnalysisError);
    const malformed = path.join(rawRoot, "malformed.yaml");
    await writeFile(malformed, "queries: [\n", "utf8");
    expect(() => loadSelectionConfig({ root: configRoot, reviewOverridesPath: malformed })).toThrow(/YAML配置读取失败/);
  });
});

describe("selection DB and HTTP integration", () => {
  it("reads one complete snapshot set in source order and honors a specified runId", async () => {
    const oldRows = [searchRow("равный первый", { count: 100 }), searchRow("равный второй", { count: 100 }), searchRow("ниже", { count: 90 })];
    const old = makeBatch(oldRows, { runId: "old-selection", anchor: "2026-11-13T00:00:00Z" });
    const current = makeBatch([searchRow("новый")], { runId: "new-selection", anchor: "2026-11-14T00:00:00Z" });
    await publishSearchBatch(context.adapter, old, { rawRoot, dialect: "sqlite" });
    await publishSearchBatch(context.adapter, current, { rawRoot, dialect: "sqlite" });
    const spy = vi.spyOn(context.adapter, "all");
    const selected = await analyzeSearchSelection(context.adapter, { runId: old.manifest.runId, config: { root: configRoot } });
    expect(selected.manifest.runId).toBe(old.manifest.runId);
    expect(selected.detail.map(row => row.query)).toEqual(["равный первый", "равный второй", "ниже"]);
    const snapshotReads = spy.mock.calls.filter(([sql]) => String(sql).includes("FROM ozon_search_query_snapshots"));
    expect(snapshotReads).toHaveLength(1);
    expect(String(snapshotReads[0][0])).toContain("ORDER BY search_popularity DESC NULLS LAST, page_number ASC, row_number ASC");
    expect(String(snapshotReads[0][0])).not.toContain("LIMIT");
  });

  it("fails on incomplete rows and never falls back to another run", async () => {
    const old = makeBatch([searchRow("старый")], { runId: "complete-old", anchor: "2026-11-13T00:00:00Z" });
    const incomplete = makeBatch([searchRow("один"), searchRow("два")], { runId: "incomplete-new", anchor: "2026-11-14T00:00:00Z" });
    await publishSearchBatch(context.adapter, old, { rawRoot, dialect: "sqlite" });
    await publishSearchBatch(context.adapter, incomplete, { rawRoot, dialect: "sqlite" });
    context.db.prepare("DELETE FROM ozon_search_query_snapshots WHERE run_id=? AND query_text=?").run(incomplete.manifest.runId, "два");
    await expect(analyzeSearchSelection(context.adapter, { config: { root: configRoot } })).rejects.toMatchObject({ code: "SELECTION_BATCH_INCOMPLETE", statusCode: 409 });
    const specified = await analyzeSearchSelection(context.adapter, { runId: old.manifest.runId, config: { root: configRoot } });
    expect(specified.manifest.runId).toBe(old.manifest.runId);
  });

  it("returns explicit no-data errors and keeps the last successful run after a failure", async () => {
    const app = express();
    app.use("/api", createSearchAnalyticsRouter());
    await request(app).get("/api/search-analytics/selection").expect(404).expect(response => expect(response.body.code).toBe("SELECTION_RUN_NOT_FOUND"));
    const success = makeBatch();
    await publishSearchBatch(context.adapter, success, { rawRoot, dialect: "sqlite" });
    await publishSearchBatch(context.adapter, failedBatch(success), { rawRoot, dialect: "sqlite" });
    const response = await request(app).get("/api/search-analytics/selection").expect(200);
    expect(response.body).toMatchObject({ runId: success.manifest.runId, filterFunnel: { rawRows: 1, top30Actual: 1 }, wordstat: { status: "NOT_REQUESTED" } });
    expect(response.body.top30).toHaveLength(1);
    expect(response.body).not.toHaveProperty("detail");
    expect(response.body).not.toHaveProperty("pages");
    expect(JSON.stringify(response.body)).not.toContain("companyId");
  });

  it("exports a 200-page run summary without expanding page receipts into Excel cells", async () => {
    const pages = Array.from({ length: 200 }, (_, index) => ({
      page: index + 1, offset: index * 50, rows: index === 199 ? 1 : 50,
      serverDate: "2026-11-14T13:47:02.800+08:00", responseSha256: sha256(`page-${index + 1}`),
    }));
    expect(JSON.stringify(pages).length).toBeGreaterThan(32767);
    const analysis = analyzeSelectionRows([searchRow("200页批次")], config, {
      runId: "export-200-pages", anchorAt: "2026-11-14T05:47:02.800Z", hash: "b".repeat(64),
      pages, pageCount: 200, expectedPages: 200, rowCount: 1,
    });
    expect(analysis.manifest).not.toHaveProperty("pages");
    expect(analysis.manifest.run).toMatchObject({
      runId: "export-200-pages", pageCount: 200, expectedPages: 200, rowCount: 1, contentSha256: "b".repeat(64),
    });
    const buffer = await buildSelectionWorkbook(analysis);
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(buffer, { type: "buffer" });
    expect(workbook.SheetNames).toHaveLength(5);
    for (const sheet of Object.values(workbook.Sheets)) {
      for (const [address, cell] of Object.entries(sheet)) {
        if (!address.startsWith("!") && typeof cell.v === "string") expect(cell.v.length, `${sheet["!ref"]}:${address}`).toBeLessThanOrEqual(32767);
      }
    }
    const metadata = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets["00_批次口径与回执元数据"], { range: 1 });
    expect(metadata.some(row => row.key === "pages" || String(row.key).startsWith("pages."))).toBe(false);
    expect(metadata.find(row => row.key === "run.pageCount")?.value).toBe(200);
    expect(metadata.find(row => row.key === "run.expectedPages")?.value).toBe(200);
    expect(metadata.find(row => row.key === "run.rowCount")?.value).toBe(1);
    expect(metadata.find(row => row.key === "run.contentSha256")?.value).toBe("b".repeat(64));
  });

  it("exports all five sheets from the same run with safe formulas, raw percents, N/A and hyperlinks", async () => {
    const old = makeBatch([searchRow("=1+1")], { runId: "export-old", anchor: "2026-11-13T00:00:00Z" });
    const current = makeBatch([searchRow("новый")], { runId: "export-current", anchor: "2026-11-14T00:00:00Z" });
    await publishSearchBatch(context.adapter, old, { rawRoot, dialect: "sqlite" });
    await publishSearchBatch(context.adapter, current, { rawRoot, dialect: "sqlite" });
    const app = express();
    app.use("/api", createSearchAnalyticsRouter());
    const response = await request(app).get(`/api/search-analytics/selection/export?runId=${old.manifest.runId}`).buffer().parse((res, callback) => {
      const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => callback(null, Buffer.concat(chunks)));
    }).expect(200).expect("X-Search-Selection-Run-Id", old.manifest.runId);
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(response.body, { type: "buffer", cellNF: true });
    expect(workbook.SheetNames).toEqual(["00_批次口径与回执元数据", "Top30_立项推荐", "四象限分类明细", "品牌词过滤记录", "不合格与异常隔离"]);
    const top = workbook.Sheets["Top30_立项推荐"];
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(top, { header: 1, raw: true });
    const headers = matrix[1] as string[];
    const queryColumn = headers.indexOf("query");
    const queryAddress = XLSX.utils.encode_cell({ r: 2, c: queryColumn });
    expect(top[queryAddress].v).toBe("'=1+1");
    expect(top[queryAddress].f).toBeUndefined();
    const caAddress = XLSX.utils.encode_cell({ r: 2, c: headers.indexOf("ca") });
    expect(top[caAddress].v).toBe(40);
    expect(top[caAddress].z).toBe('0.00"%"');
    const ozonAddress = XLSX.utils.encode_cell({ r: 2, c: headers.indexOf("ozon_search_url") });
    expect(top[ozonAddress].l.Target).toContain("https://www.ozon.ru/search/?text=%3D1%2B1");
    const costAddress = XLSX.utils.encode_cell({ r: 2, c: headers.indexOf("max_total_cost_rub_10pct") });
    expect(top[costAddress].v).toBe("N/A");
    const detailMatrix = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets["四象限分类明细"], { header: 1, raw: true });
    expect(detailMatrix[1][(detailMatrix[0] as string[]).indexOf("dynamic7")]).toBe("N/A");
    const metadata = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets["00_批次口径与回执元数据"], { range: 1 });
    expect(metadata.find(row => row.key === "runId")?.value).toBe(old.manifest.runId);
    for (const sheet of Object.values(workbook.Sheets)) for (const cell of Object.values(sheet)) expect(cell).not.toHaveProperty("f");
  });
});
