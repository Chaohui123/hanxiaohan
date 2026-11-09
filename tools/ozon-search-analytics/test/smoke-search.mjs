import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../../apps/api-services/package.json", import.meta.url));
const XLSX = require("xlsx");
import { loadCompleteBatch } from "../src/publish-run.mjs";

const directory = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Usage: node smoke-api.mjs <complete-run-directory>");
const batch = await loadCompleteBatch(directory);
const temporary = await mkdtemp(path.join("temp", "search-analytics-smoke-"));
const key = randomBytes(32).toString("hex");
process.env.DATABASE_URL = "postgresql://127.0.0.1:1/onzo_smoke_unavailable";
process.env.SQLITE_DB_PATH = path.join(temporary, "smoke.db");
process.env.SEARCH_ANALYTICS_RAW_DIR = path.join(temporary, "raw");
process.env.SEARCH_ANALYTICS_INGEST_KEY = key;
process.env.ENV = "development";
const { getDb, closeDb } = await import("../../../apps/api-services/src/db/connection.ts");
const { createSearchAnalyticsRouter } = await import("../../../apps/api-services/src/routes/search-analytics.route.ts");
const app = express();
app.use(express.json({ limit: "4mb" }));
app.use("/api", createSearchAnalyticsRouter());
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
const address = server.address();
if (!address || typeof address === "string") throw new Error("No local test port");
const base = `http://127.0.0.1:${address.port}`;
const checks = [];
const body = gzipSync(JSON.stringify(batch));

async function json(pathname, options) {
  const response = await fetch(`${base}${pathname}`, options);
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}

try {
  const first = await json("/api/search-analytics/ingest", { method: "POST", headers: { "Content-Type": "application/gzip", "X-Search-Ingest-Key": key }, body });
  assert.equal(first.rowCount, 9942);
  assert.equal(first.idempotent, false);
  checks.push("完整gzip ingest：199页、9942行");

  const firstPage = await json("/api/search-analytics/queries?window=7&page=1&pageSize=50");
  assert.equal(firstPage.total, 9942);
  assert.equal(firstPage.items.length, 50);
  assert.equal(firstPage.items[0].query, "куртка зимняя женская");
  assert.equal(firstPage.items[0].count, 346873);
  assert.equal(firstPage.items[0].dynamic28, null);
  checks.push("第一页与Ozon页面一致，会员动态值为NULL");

  const lastPage = await json("/api/search-analytics/queries?window=7&page=199&pageSize=50");
  assert.equal(lastPage.items.length, 42);
  const originalLast = JSON.parse(batch.pages[198].rawBody).data;
  assert.deepEqual(lastPage.items.map(row => row.query), originalLast.map(row => row.query));
  checks.push("第199页42行与原始回执逐条一致");

  const filtered = await json(`/api/search-analytics/queries?window=7&query=${encodeURIComponent("телефон")}&pageSize=200`);
  assert.ok(filtered.items.some(row => row.query === "телефон"));
  const phone = filtered.items.find(row => row.query === "телефон");
  assert.equal(phone.count, 110920);
  assert.equal(phone.ord, 869);
  const trend = await json(`/api/search-analytics/queries/trend?query=${encodeURIComponent("телефон")}`);
  assert.equal(trend.items.length, 1);
  assert.equal(trend.items[0].overlapsPrevious, false);
  checks.push("关键词过滤和原生7天趋势一致");

  const derived = await json("/api/search-analytics/queries?window=28");
  assert.equal(derived.coverageStatus, "insufficient_history");
  assert.equal(derived.coverageDays, 7);
  assert.equal(derived.items.length, 0);
  checks.push("首周不伪造28天，明确显示7/28积累覆盖");

  const runs = await json("/api/search-analytics/runs");
  assert.equal(runs.lastSuccess.runId, batch.manifest.runId);
  assert.equal(runs.lastSuccess.rowCount, 9942);
  assert.equal(runs.lastSuccess.status, "succeeded");
  checks.push("最近成功运行与采集清单一致");

  const csv = await fetch(`${base}/api/search-analytics/export?format=csv&query=${encodeURIComponent("телефон")}`);
  assert.equal(csv.status, 200);
  const csvText = await csv.text();
  assert.ok(csvText.includes("телефон"));
  assert.ok(csvText.includes("native_7d"));
  const xlsx = await fetch(`${base}/api/search-analytics/export?format=xlsx&query=${encodeURIComponent("телефон")}`);
  if (xlsx.status !== 200) throw new Error(`XLSX export failed: ${await xlsx.text()}`);
  const workbook = XLSX.read(Buffer.from(await xlsx.arrayBuffer()), { type: "buffer" });
  const exportedRows = XLSX.utils.sheet_to_json(workbook.Sheets.search_queries);
  assert.ok(exportedRows.length > 0);
  const exportedPhone = exportedRows.find(row => row.query === "телефон");
  assert.equal(exportedPhone.gmv, 20129064);
  assert.equal(exportedPhone.ord, 869);
  assert.ok(workbook.SheetNames.includes("README"));
  checks.push("CSV/XLSX内容与筛选、原始指标和口径说明一致");

  const second = await json("/api/search-analytics/ingest", { method: "POST", headers: { "Content-Type": "application/gzip", "X-Search-Ingest-Key": key }, body });
  assert.equal(second.idempotent, true);
  const db = await getDb();
  const counts = await db.all("SELECT (SELECT COUNT(*) FROM ozon_search_query_snapshots) AS snapshots, (SELECT COUNT(*) FROM ozon_search_raw_responses) AS rawPages, (SELECT COUNT(*) FROM ozon_search_collection_runs) AS runs");
  assert.deepEqual(counts, [{ snapshots: 9942, rawPages: 199, runs: 1 }]);
  const rawIndexes = await db.all("SELECT object_path AS objectPath, response_sha256 AS responseSha256 FROM ozon_search_raw_responses WHERE page_number IN (1,199) ORDER BY page_number");
  for (const [index, row] of rawIndexes.entries()) {
    const raw = JSON.parse(await readFile(path.join(process.env.SEARCH_ANALYTICS_RAW_DIR, row.objectPath), "utf8"));
    assert.equal(raw.responseSha256, row.responseSha256);
    assert.equal(raw.rawBody, batch.pages[index === 0 ? 0 : 198].rawBody);
    assert.equal(raw.requestHeaders, undefined);
  }
  checks.push("重复导入幂等，原始199页索引、内容和哈希一致，无敏感请求头");

  const report = {
    verifiedAt: new Date().toISOString(), status: "PASS", scope: "isolated loopback API + temporary SQLite; not production deployment",
    runId: batch.manifest.runId, rows: 9942, pages: 199, contentSha256: batch.manifest.contentSha256,
    checks, database: { snapshots: 9942, rawResponses: 199, successfulRuns: 1 },
    productionChanges: false,
  };
  await writeFile(path.join(directory, "local-api-validation.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve));
  await closeDb();
  await rm(temporary, { recursive: true, force: true });
}
