import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProxyAgent, fetch } from "../tools/ozon-mcp-server/node_modules/undici/index.js";
import { directRetryDelayMs, parseDirectCampaignIds, parseDirectReportTsv, selectDirectCampaignRows, summarizeDirectRows, utcDayOffset } from "./direct-report-core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = process.env.DIRECT_REPORT_OUTPUT_DIR || path.join(ROOT, "temp", "direct-reports");
let campaignIds;
let campaignId;
const startedAt = new Date().toISOString();
const runId = startedAt.replaceAll(":", "-").replaceAll(".", "-");
const dateTo = startedAt.slice(0, 10);
const dateFrom = utcDayOffset(dateTo, -29);
const lockPath = path.join(outputDir, "collector.lock");
let token;
let proxy;
let lockHandle;
let ownsLock = false;

async function acquireLock() {
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ runId, startedAt, pid: process.pid }));
    ownsLock = true;
    return handle;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let stale = false;
    try {
      const existing = JSON.parse(await readFile(lockPath, "utf8"));
      stale = Date.now() - new Date(existing.startedAt).getTime() > 30 * 60 * 1000;
    } catch {
      stale = true;
    }
    if (!stale) throw new Error("Direct report collection is already running");
    await rm(lockPath, { force: true });
    return acquireLock();
  }
}

async function writeJsonAtomic(filePath, value) {
  await writeFile(`${filePath}.${runId}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(`${filePath}.${runId}.tmp`, filePath);
}

async function requestReport() {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch("https://api.direct.yandex.com/json/v5/reports", {
      method: "POST",
      dispatcher: proxy,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
        "Accept-Language": "en",
        processingMode: "auto",
        returnMoneyInMicros: "false",
        skipReportHeader: "false",
        skipReportSummary: "false",
      },
      body: JSON.stringify({
        params: {
          SelectionCriteria: {
            DateFrom: dateFrom,
            DateTo: dateTo,
            Filter: [{ Field: "CampaignId", Operator: campaignIds.length > 1 ? "IN" : "EQUALS", Values: campaignIds }],
          },
          FieldNames: ["Date", "CampaignId", "CampaignName", "Impressions", "Clicks", "Ctr", "AvgCpc", "Cost", "Conversions", "CostPerConversion"],
          ReportName: `ONZO Ads Manager rolling 30 days ${runId}`,
          ReportType: "CAMPAIGN_PERFORMANCE_REPORT",
          DateRangeType: "CUSTOM_DATE",
          Format: "TSV",
          IncludeVAT: "NO",
          IncludeDiscount: "NO",
        },
      }),
      signal: AbortSignal.timeout(45000),
    });
    const text = await response.text();
    if (response.status === 200) return text;
    if (![201, 202, 429, 500, 502, 503, 504].includes(response.status)) {
      throw new Error(`Direct Reports returned HTTP ${response.status}: ${text.slice(0, 600)}`);
    }
    if (attempt === 5) throw new Error(`Direct Reports did not complete after ${attempt + 1} attempts: HTTP ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, directRetryDelayMs(response.headers.get("retry-after"))));
  }
  throw new Error("Direct Reports ended unexpectedly");
}

try {
  await mkdir(outputDir, { recursive: true });
  lockHandle = await acquireLock();
  campaignIds = parseDirectCampaignIds(process.env.YANDEX_DIRECT_CAMPAIGN_IDS || process.env.YANDEX_DIRECT_CAMPAIGN_ID || "715426752,716088179");
  campaignId = campaignIds[0];
  token = process.env.YANDEX_DIRECT_OAUTH_TOKEN || (await readFile(path.join(ROOT, "temp", "yd-code.txt"), "utf8")).trim();
  if (!token) throw new Error("Yandex Direct token is empty");
  proxy = new ProxyAgent(process.env.YANDEX_DIRECT_PROXY_URL || "http://127.0.0.1:10808");
  const tsv = await requestReport();
  const dailyRows = parseDirectReportTsv(tsv);
  if (dailyRows.some((row) => !campaignIds.includes(row.campaignId))) throw new Error("Direct report contains an unexpected campaign ID");
  const windows = {
    currentDay: { from: dateTo, to: dateTo },
    last7Days: { from: utcDayOffset(dateTo, -7), to: utcDayOffset(dateTo, -1) },
    previous7Days: { from: utcDayOffset(dateTo, -14), to: utcDayOffset(dateTo, -8) },
    rolling30Days: { from: dateFrom, to: dateTo },
  };
  const byCampaign = campaignIds.map(id => {
    const rows = selectDirectCampaignRows(dailyRows, id);
    return {
      campaignId: id,
      hasReportRows: rows.length > 0,
      reportRowCount: rows.length,
      currentDay: summarizeDirectRows(rows, windows.currentDay),
      last7Days: summarizeDirectRows(rows, windows.last7Days),
      previous7Days: summarizeDirectRows(rows, windows.previous7Days),
      rolling30Days: summarizeDirectRows(rows, windows.rolling30Days),
    };
  });
  const primary = byCampaign[0];
  const report = {
    schemaVersion: 1,
    source: "ONZO Ads Manager / Yandex Direct JSON v5 Reports",
    readOnly: true,
    settingsChanges: false,
    collectedAt: new Date().toISOString(),
    startedAt,
    runId,
    campaignId,
    campaignIds,
    primaryCampaignId: campaignId,
    legacySummaryScope: "currentDay、last7Days、previous7Days、rolling30Days仅对应primaryCampaignId；所有campaign分别看byCampaign",
    period: { from: dateFrom, to: dateTo },
    currentDayPartial: true,
    currentDayNote: "The current UTC day is partial and reported separately; complete-week comparisons end yesterday",
    comparisonWindowsExcludeCurrentDay: true,
    currentDay: primary.currentDay,
    last7Days: primary.last7Days,
    previous7Days: primary.previous7Days,
    rolling30Days: primary.rolling30Days,
    byCampaign,
    dailyRows,
    limitations: [
      "Reports are read-only evidence; campaigns.get returning an empty marketplace campaign does not negate these report rows",
      "No campaign, budget, CPA, product, stock or advertising-state method is called",
      "Zero conversions make actual CPA undefined, not zero or the target CPA",
      "Direct off-site metrics must not be mixed with Ozon-native advertising metrics",
      "byCampaign按campaign分别计算；hasReportRows=false表示当前报表无行，不证明审核通过、已产生投放或未来仍为0",
    ],
  };
  await writeFile(path.join(outputDir, `direct-${runId}.tsv`), tsv, "utf8");
  await writeJsonAtomic(path.join(outputDir, `direct-${runId}.json`), report);
  await writeJsonAtomic(path.join(outputDir, "latest.json"), report);
  await rm(path.join(outputDir, "last-error.json"), { force: true });
  console.log(JSON.stringify({ status: "OK", runId, campaignIds, byCampaign, output: path.join(outputDir, "latest.json") }, null, 2));
} catch (error) {
  await mkdir(outputDir, { recursive: true });
  const failure = {
    schemaVersion: 1,
    status: ownsLock ? "FETCH_FAILED_NOT_ZERO" : "SKIPPED_OVERLAP_NOT_ZERO",
    collectedAt: new Date().toISOString(),
    startedAt,
    runId,
    campaignId,
    campaignIds,
    error: String(error?.message || error).slice(0, 1000),
    latestReportPreserved: true,
    settingsChanges: false,
  };
  if (ownsLock) await writeJsonAtomic(path.join(outputDir, "last-error.json"), failure);
  console.error(JSON.stringify(failure));
  process.exitCode = 1;
} finally {
  await lockHandle?.close();
  if (ownsLock) await rm(lockPath, { force: true });
  await proxy?.close();
}
