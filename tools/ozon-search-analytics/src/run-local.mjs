import { appendFileSync, readFileSync, renameSync } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { format } from "node:util";
import { gzipSync } from "node:zlib";
import { collect, parseArgs } from "./local-collector.mjs";
import { publishBatch } from "./publish-run.mjs";

const output = path.resolve("data/search-analytics");
const lockPath = path.join(output, "collector.lock");
const logPath = path.join(output, "scheduled.log");
let handle;
await mkdir(output, { recursive: true });

function ensureUtf8Log() {
  let bytes;
  try { bytes = readFileSync(logPath); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  let valid = true;
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { valid = false; }
  if (valid && bytes.includes(0)) valid = false;
  if (valid) return null;
  const legacy = `${logPath}.${new Date().toISOString().replace(/[:.]/g, "-")}.legacy`;
  renameSync(logPath, legacy);
  return legacy;
}

const legacyLog = ensureUtf8Log();
for (const method of ["log", "warn", "error"]) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    appendFileSync(logPath, `${format(...args)}\n`, "utf8");
    original(...args);
  };
}
if (legacyLog) console.log(`旧日志已保留：${legacyLog}`);
if (process.argv.includes("--log-self-test")) {
  console.log("UTF-8 日志自检：中文正常");
  process.exit(0);
}

async function lock() {
  try {
    handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let owner = null;
    try { owner = JSON.parse(await readFile(lockPath, "utf8")); } catch { /* preserve an unreadable lock */ }
    let alive = true;
    if (owner?.pid && Number.isInteger(owner.pid)) {
      try { process.kill(owner.pid, 0); } catch (error) { alive = error.code !== "ESRCH"; }
    }
    if (alive) throw new Error("Another search analytics collector is running; skip this run");
    await rm(lockPath);
    handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  }
}

async function save(name, value) {
  const file = path.join(output, name);
  await writeFile(`${file}.${process.pid}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const { rename } = await import("node:fs/promises");
  await rename(`${file}.${process.pid}.tmp`, file);
}

async function reportFailure(startedAt, error) {
  const baseUrl = process.env.SEARCH_ANALYTICS_API_URL;
  const ingestKey = process.env.SEARCH_ANALYTICS_INGEST_KEY;
  let companyId = process.env.SEARCH_ANALYTICS_COMPANY_ID || "";
  if (!companyId) {
    try { companyId = JSON.parse(await readFile(path.join(output, "last-success.json"), "utf8")).companyId || ""; } catch { /* first run may not have a success */ }
  }
  if (!baseUrl || !ingestKey || !/^\d{1,32}$/.test(companyId)) return { reported: false };
  const now = new Date().toISOString();
  const manifest = {
    runId: startedAt.replace(/[:.]/g, "-"), collectorVersion: "local-chrome-v1", parserVersion: "search-v2-fields-v1",
    startedAt, finishedAt: now, status: "FAILED", complete: false,
    sourceType: "ozon_seller_ui_native_query_report", sourceDependency: "LOCAL_CHROME_ACTIVE_TAB_AND_LOGIN",
    companyId, nativePeriod: { requested: "days_7", label: "7 days", start: null, end: null, timezone: null },
    filters: { text: "", sort_by: "count", sort_dir: "desc", period: "days_7" },
    expectedPages: 0, pageCount: 0, total: 0, rowCount: 0,
    coverage: "FAILED", fields: [], pages: [], contentSha256: null,
    errorCode: error.code || "COLLECTION_FAILED", error: error.message.slice(0, 500),
  };
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/search-analytics/ingest`, {
    method: "POST", headers: { "Content-Type": "application/gzip", "X-Search-Ingest-Key": ingestKey },
    body: gzipSync(JSON.stringify({ manifest, pages: [] })), signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) return { reported: false, httpStatus: response.status };
  return { reported: true };
}

try {
  await lock();
  const startedAt = new Date().toISOString();
  try {
    const { directory, manifest } = await collect(parseArgs([`--output=${output}`]));
    const result = await publishBatch(directory);
    const success = {
      runId: manifest.runId, companyId: manifest.companyId, status: "succeeded", rowCount: manifest.rowCount,
      pageCount: manifest.pageCount, contentSha256: manifest.contentSha256, anchorAt: manifest.pages[0]?.serverDate || manifest.startedAt,
      publishedAt: new Date().toISOString(), idempotent: result.idempotent,
    };
    await save("last-success.json", success);
    await save("last-attempt.json", success);
    await rm(path.join(output, "last-error.json"), { force: true });
    console.log(JSON.stringify(success, null, 2));
  } catch (error) {
    const report = { runId: startedAt.replace(/[:.]/g, "-"), startedAt, finishedAt: new Date().toISOString(), status: "failed", errorCode: error.code || "COLLECTION_FAILED", error: error.message.slice(0, 500) };
    try { report.serverNotification = await reportFailure(startedAt, error); }
    catch (notificationError) { report.serverNotification = { reported: false, error: notificationError.message.slice(0, 200) }; }
    await save("last-attempt.json", report);
    await save("last-error.json", report);
    throw error;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (handle) await handle.close();
  await rm(lockPath, { force: true });
}
