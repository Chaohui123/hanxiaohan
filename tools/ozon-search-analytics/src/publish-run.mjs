import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { normalizePage, validateBatch } from "./local-collector.mjs";

export async function loadCompleteBatch(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  if (manifest.status !== "COLLECTED" || manifest.complete !== true) throw new Error("Only a complete COLLECTED batch can be published");
  const pages = [];
  const normalized = [];
  for (let index = 1; index <= manifest.pageCount; index++) {
    const page = JSON.parse(await readFile(path.join(directory, `page-${String(index).padStart(4, "0")}.json`), "utf8"));
    const hash = createHash("sha256").update(page.rawBody, "utf8").digest("hex");
    if (page.responseSha256 !== hash || manifest.pages[index - 1]?.responseSha256 !== hash) throw new Error(`Page ${index} hash mismatch`);
    if (page.httpStatus !== 200 || page.request.offset !== String((index - 1) * 50)) throw new Error(`Page ${index} request mismatch`);
    if (Object.keys(page).some(key => /headers$/i.test(key) && key !== "requestHeaderNames")) throw new Error("Sensitive request headers must not be published");
    pages.push(page);
    normalized.push(normalizePage(page));
  }
  validateBatch(normalized, true);
  const contentHash = createHash("sha256").update(pages.map(page => page.responseSha256).join("\n")).digest("hex");
  if (contentHash !== manifest.contentSha256) throw new Error("Batch content hash mismatch");
  if (normalized.reduce((sum, page) => sum + page.body.data.length, 0) !== manifest.rowCount) throw new Error("Batch row count mismatch");
  return { manifest, pages };
}

export async function publishBatch(directory, options = {}) {
  const batch = await loadCompleteBatch(directory);
  const baseUrl = options.baseUrl || process.env.SEARCH_ANALYTICS_API_URL;
  const ingestKey = options.ingestKey || process.env.SEARCH_ANALYTICS_INGEST_KEY;
  if (!baseUrl || !ingestKey) throw new Error("SEARCH_ANALYTICS_API_URL and SEARCH_ANALYTICS_INGEST_KEY are required");
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/search-analytics/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/gzip",
      "X-Search-Ingest-Key": ingestKey,
      ...(process.env.ONZO_API_KEY ? { "X-API-Key": process.env.ONZO_API_KEY } : {}),
    },
    body: gzipSync(JSON.stringify(batch)),
    signal: AbortSignal.timeout(120_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`Ingest HTTP ${response.status}: ${result.error?.message || result.error || "request failed"}`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  if (!directory) throw new Error("Usage: node publish-run.mjs <run-directory>");
  const batch = await loadCompleteBatch(directory);
  if (process.argv.includes("--verify-only")) {
    console.log(JSON.stringify({ status: "VERIFIED_COMPLETE", runId: batch.manifest.runId, pages: batch.manifest.pageCount, rows: batch.manifest.rowCount, contentSha256: batch.manifest.contentSha256 }, null, 2));
  } else {
    const result = await publishBatch(directory);
    console.log(JSON.stringify(result, null, 2));
  }
}
