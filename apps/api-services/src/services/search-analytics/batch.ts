import { createHash } from "node:crypto";
import { z } from "zod";
import { SEARCH_METRICS, SEARCH_SNAPSHOT_COLUMNS } from "./metric-definitions.js";

const runIdSchema = z.string().regex(/^[\w.-]{1,160}$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const filtersSchema = z.object({
  text: z.string().max(500), sort_by: z.literal("count"), sort_dir: z.enum(["asc", "desc"]), period: z.literal("days_7"),
}).strict();
const manifestSchema = z.object({
  runId: runIdSchema,
  collectorVersion: z.string().max(100), parserVersion: z.string().max(100),
  startedAt: z.string().datetime(), finishedAt: z.string().datetime(),
  status: z.enum(["COLLECTED", "FAILED"]), complete: z.boolean(),
  sourceType: z.string().max(100), sourceDependency: z.string().max(150),
  companyId: z.string().regex(/^\d{1,32}$/),
  nativePeriod: z.object({
    requested: z.literal("days_7"), label: z.string().max(100),
    start: z.string().nullable().optional(), end: z.string().nullable().optional(), timezone: z.string().nullable().optional(),
    basis: z.string().max(500).optional(),
  }).passthrough(),
  filters: filtersSchema,
  expectedPages: z.number().int().nonnegative(), pageCount: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(), rowCount: z.number().int().nonnegative(),
  coverage: z.string().max(200), fields: z.array(z.string().max(150)).max(200),
  pages: z.array(z.object({
    page: z.number().int().positive(), offset: z.number().int().nonnegative(), rows: z.number().int().nonnegative(),
    serverDate: z.string().nullable(), responseSha256: hashSchema,
  }).passthrough()).max(5000),
  contentSha256: hashSchema.nullable().optional(),
  errorCode: z.string().max(200).optional(), error: z.string().max(500).optional(),
}).passthrough();
const rawPageSchema = z.object({
  request: filtersSchema.extend({ limit: z.string().regex(/^\d+$/), offset: z.string().regex(/^\d+$/) }),
  httpStatus: z.literal(200), serverDate: z.string().nullable(), contentType: z.string().nullable(),
  requestHeaderNames: z.array(z.string().max(150)).max(100), responseSha256: hashSchema,
  rawBody: z.string().max(2_000_000),
}).strict();

export type SearchManifest = z.infer<typeof manifestSchema>;
export type SearchRawPage = z.infer<typeof rawPageSchema>;
export type SearchBatch = { manifest: SearchManifest; pages: SearchRawPage[] };
export type NormalizedSearchBatch = {
  manifest: SearchManifest;
  run: Record<string, unknown>;
  snapshots: Array<Record<string, unknown>>;
  rawPages: Array<{ pageNumber: number; requestJson: string; responseSha256: string; serverDate: string | null; contents: string }>;
  failed: boolean;
};

export class SearchBatchError extends Error {
  constructor(message: string, public readonly statusCode = 400, public readonly code = "INVALID_SEARCH_BATCH") {
    super(message);
    this.name = "SearchBatchError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function numberMetric(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined || value === "—") return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new SearchBatchError(`Metric ${key} must be a finite number or null`);
  return value;
}

function dateString(value: string | null, field: string): string | null {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new SearchBatchError(`Invalid ${field}`);
  if (timestamp > Date.now() + 10 * 60_000) throw new SearchBatchError(`${field} is in the future`);
  return new Date(timestamp).toISOString();
}

function assertEqualFilters(actual: Record<string, unknown>, expected: Record<string, unknown>): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new SearchBatchError("Filters changed between pages");
}

export function normalizeSearchBatch(payload: unknown): NormalizedSearchBatch {
  const input = payload as SearchBatch;
  if (!input || !Array.isArray(input.pages)) throw new SearchBatchError("manifest and pages are required");
  const parsedManifest = manifestSchema.safeParse(input.manifest);
  if (!parsedManifest.success) throw new SearchBatchError(`Invalid manifest: ${parsedManifest.error.issues[0]?.message || "schema mismatch"}`);
  const manifest = parsedManifest.data;
  if (manifest.status === "FAILED") {
    if (manifest.complete || input.pages.length) throw new SearchBatchError("A failed attempt cannot carry published pages");
    return {
      manifest, failed: true, snapshots: [], rawPages: [],
      run: {
        run_id: manifest.runId, company_id: manifest.companyId, status: "failed",
        source_type: manifest.sourceType, source_dependency: manifest.sourceDependency,
        native_period: manifest.nativePeriod.requested, period_start: null, period_end: null, timezone: null, anchor_at: null,
        filters_json: JSON.stringify(manifest.filters), filter_hash: sha256(JSON.stringify(manifest.filters)),
        collector_version: manifest.collectorVersion, parser_version: manifest.parserVersion, coverage: "failed",
        expected_pages: 0, page_count: 0, total_rows: 0, row_count: 0,
        fields_json: "[]", pages_json: "[]", manifest_json: JSON.stringify(manifest), content_sha256: null,
        error_code: manifest.errorCode || "COLLECTION_FAILED", error_message: manifest.error || "Collection failed",
        started_at: manifest.startedAt, finished_at: manifest.finishedAt,
      },
    };
  }
  if (!manifest.complete || manifest.pageCount < 1 || manifest.expectedPages < 1) throw new SearchBatchError("Only complete batches can be published");
  if (input.pages.length !== manifest.pageCount || manifest.pages.length !== manifest.pageCount) throw new SearchBatchError("Page count does not match the manifest");
  if (manifest.expectedPages !== Math.ceil(manifest.total / 50) || manifest.rowCount !== manifest.total) throw new SearchBatchError("Expected pages or observed row count is inconsistent");
  if (manifest.rowCount > 1_000_000) throw new SearchBatchError("Batch is too large");

  const snapshots: Array<Record<string, unknown>> = [];
  const rawPages: NormalizedSearchBatch["rawPages"] = [];
  const rawHashes: string[] = [];
  const querySet = new Set<string>();
  const fieldSet = new Set<string>();
  let anchorAt: string | null = null;
  for (let index = 0; index < input.pages.length; index++) {
    const parsedPage = rawPageSchema.safeParse(input.pages[index]);
    if (!parsedPage.success) throw new SearchBatchError(`Invalid page ${index + 1}: only sanitized request metadata and rawBody are accepted`);
    const page = parsedPage.data;
    const pageNumber = index + 1;
    const expectedOffset = index * 50;
    if (page.request.limit !== "50" || page.request.offset !== String(expectedOffset)) throw new SearchBatchError(`Unexpected pagination at page ${pageNumber}`);
    assertEqualFilters({ text: page.request.text, sort_by: page.request.sort_by, sort_dir: page.request.sort_dir, period: page.request.period }, manifest.filters);
    const rawHash = sha256(page.rawBody);
    if (rawHash !== page.responseSha256 || manifest.pages[index].responseSha256 !== rawHash || manifest.pages[index].page !== pageNumber || manifest.pages[index].offset !== expectedOffset) {
      throw new SearchBatchError(`Page ${pageNumber} evidence hash or manifest mismatch`);
    }
    const serverDate = dateString(page.serverDate, `page ${pageNumber} serverDate`);
    if (serverDate && manifest.pages[index].serverDate && Date.parse(manifest.pages[index].serverDate as string) !== Date.parse(serverDate)) throw new SearchBatchError(`Page ${pageNumber} server date differs from manifest`);
    let body: { data?: unknown; offset?: unknown; total?: unknown };
    try { body = JSON.parse(page.rawBody); } catch { throw new SearchBatchError(`Page ${pageNumber} is not valid JSON`); }
    if (!Array.isArray(body.data) || Number(body.offset) !== expectedOffset || Number(body.total) !== manifest.total || body.data.length !== manifest.pages[index].rows) {
      throw new SearchBatchError(`Page ${pageNumber} response envelope does not match the batch`);
    }
    for (const [rowIndex, value] of body.data.entries()) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new SearchBatchError(`Invalid row at page ${pageNumber}`);
      const row = value as Record<string, unknown>;
      if (typeof row.query !== "string" || !row.query.trim() || row.query.length > 2000) throw new SearchBatchError(`Invalid query at page ${pageNumber}`);
      if (querySet.has(row.query)) throw new SearchBatchError("Duplicate query across pages; the batch is not coherent");
      querySet.add(row.query);
      Object.keys(row).forEach(field => fieldSet.add(field));
      for (const metric of SEARCH_METRICS) {
        if (metric.field.startsWith("dynamic") || metric.field === "trendForYear") continue;
        numberMetric(row, metric.field);
      }
      if (row.trendForYear !== undefined && row.trendForYear !== null && !Array.isArray(row.trendForYear)) throw new SearchBatchError("trendForYear must remain an array or null");
      const collectedAt = serverDate || manifest.finishedAt;
      const metricsJson = JSON.stringify(row);
      const snapshot: Record<string, unknown> = {
        snapshot_id: sha256(`${manifest.runId}\0${row.query}`), run_id: manifest.runId, company_id: manifest.companyId,
        query_text: row.query, normalized_query: row.query.trim().toLocaleLowerCase("ru-RU").replace(/\s+/g, " "),
        page_number: pageNumber, row_number: rowIndex + 1, collected_at: collectedAt,
        dynamic_28_pct: null, dynamic_7_pct: null,
        seasonality_json: row.trendForYear === undefined || row.trendForYear === null ? null : JSON.stringify(row.trendForYear),
        metrics_json: metricsJson, raw_row_sha256: sha256(metricsJson),
      };
      for (const metric of SEARCH_METRICS) if (metric.column && metric.column !== "seasonality_json") snapshot[metric.column] = numberMetric(row, metric.field);
      const missing = SEARCH_SNAPSHOT_COLUMNS.filter(column => !(column in snapshot));
      if (missing.length) throw new SearchBatchError(`Snapshot mapping is incomplete: ${missing.join(",")}`);
      snapshots.push(snapshot);
    }
    rawHashes.push(rawHash);
    if (!anchorAt && serverDate) anchorAt = serverDate;
    rawPages.push({
      pageNumber, requestJson: JSON.stringify(page.request), responseSha256: rawHash, serverDate,
      contents: JSON.stringify({
        request: page.request, httpStatus: page.httpStatus, serverDate: page.serverDate,
        contentType: page.contentType, requestHeaderNames: page.requestHeaderNames,
        responseSha256: rawHash, rawBody: page.rawBody,
      }),
    });
  }
  if (querySet.size !== manifest.total) throw new SearchBatchError("Complete batch does not cover the observed query total");
  if (manifest.fields.some(field => !fieldSet.has(field))) throw new SearchBatchError("Manifest fields are absent from the raw rows");
  const contentHash = sha256(rawHashes.join("\n"));
  if (manifest.contentSha256 !== contentHash) throw new SearchBatchError("Batch content hash mismatch");
  return {
    manifest, failed: false, snapshots, rawPages,
    run: {
      run_id: manifest.runId, company_id: manifest.companyId, status: "succeeded",
      source_type: manifest.sourceType, source_dependency: manifest.sourceDependency,
      native_period: manifest.nativePeriod.requested,
      period_start: manifest.nativePeriod.start || null, period_end: manifest.nativePeriod.end || null,
      timezone: manifest.nativePeriod.timezone || null, anchor_at: anchorAt || manifest.startedAt,
      filters_json: JSON.stringify(manifest.filters), filter_hash: sha256(JSON.stringify(manifest.filters)),
      collector_version: manifest.collectorVersion, parser_version: manifest.parserVersion, coverage: manifest.coverage,
      expected_pages: manifest.expectedPages, page_count: manifest.pageCount, total_rows: manifest.total, row_count: manifest.rowCount,
      fields_json: JSON.stringify([...fieldSet].sort()), pages_json: JSON.stringify(manifest.pages), manifest_json: JSON.stringify(manifest),
      content_sha256: contentHash, error_code: null, error_message: null,
      started_at: manifest.startedAt, finished_at: manifest.finishedAt,
    },
  };
}
