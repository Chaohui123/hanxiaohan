import { createHash } from "node:crypto";
import type { DbAdapter } from "../db/connection.js";
import { notifier } from "./notifier.js";
import { buildWordstatWeeklyCard } from "./wordstat-weekly-card.js";
import { querySearchSnapshots } from "./search-analytics/store.js";

export type WeeklyReport = Record<string, unknown> & {
  reportId: string;
  idempotencyKey: string;
  eventId: string;
  overallStatus: "success" | "degraded_partial" | "failed_alert_only";
  globalSourceAsOfMax: string | null;
  generatedAt: string;
  runDate: string;
  top10Observations: Array<Record<string, unknown>>;
  failedRequests: Array<Record<string, unknown>>;
  sellerValidationContext: Record<string, unknown>;
};

interface ObjectReader {
  getObject(bucket: string, key: string): Promise<Buffer | null>;
}

interface SyncOptions {
  client: ObjectReader;
  db: DbAdapter;
  dryRun?: boolean;
  bucket?: string;
  manifestKey?: string;
  notify?: (card: Record<string, unknown>, correlationId: string) => Promise<boolean>;
}

function requiredText(value: unknown, field: string, maximum = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`${field} is required`);
  return value.trim();
}

export function validateWeeklyReport(value: unknown): WeeklyReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Weekly report must be an object");
  const report = value as Record<string, unknown>;
  requiredText(report.reportId, "reportId");
  requiredText(report.idempotencyKey, "idempotencyKey", 1024);
  requiredText(report.eventId, "eventId");
  requiredText(report.runDate, "runDate");
  const status = requiredText(report.overallStatus, "overallStatus");
  if (!["success", "degraded_partial", "failed_alert_only"].includes(status)) throw new Error("Unknown weekly report status");
  const generatedAt = requiredText(report.generatedAt, "generatedAt");
  if (!Number.isFinite(Date.parse(generatedAt)) || Date.parse(generatedAt) > Date.now() + 300_000) throw new Error("Weekly report generatedAt is invalid or in the future");
  const sourceAsOf = report.globalSourceAsOfMax;
  if (sourceAsOf !== null && sourceAsOf !== undefined && (!/^\d{4}-\d{2}-\d{2}/.test(String(sourceAsOf)) || !Number.isFinite(Date.parse(String(sourceAsOf))))) throw new Error("sourceAsOf is invalid");
  if (!Array.isArray(report.top10Observations) || !Array.isArray(report.failedRequests)) throw new Error("Weekly report observations/failures must be arrays");
  const seller = report.sellerValidationContext;
  if (!seller || typeof seller !== "object" || (seller as Record<string, unknown>).promoAutoDecision !== false) throw new Error("Weekly report must preserve PROMO_AUTO_DECISION=false");
  return report as WeeklyReport;
}

export async function withLiveSellerContext(db: DbAdapter, report: WeeklyReport): Promise<WeeklyReport> {
  const native = await querySearchSnapshots(db, { window: "7", page: 1, pageSize: 1 });
  const run = native.run as Record<string, unknown> | null | undefined;
  const period = run?.nativePeriod;
  const nativeWindowDays = period === "days_7" || (period && typeof period === "object" && (period as Record<string, unknown>).requested === "days_7") ? 7 : null;
  const companyId = run?.companyId ? String(run.companyId) : undefined;
  const derived = await querySearchSnapshots(db, { window: "28", ...(companyId ? { companyId } : {}) });
  const coverageDays = typeof derived.coverageDays === "number" ? derived.coverageDays : null;
  return {
    ...report,
    sellerValidationContext: {
      ...report.sellerValidationContext,
      nativeWindowDays,
      nativeBatchPages: typeof run?.pageCount === "number" ? run.pageCount : null,
      nativeBatchRows: typeof run?.rowCount === "number" ? run.rowCount : null,
      nativeBatchCollectedAt: typeof run?.anchorAt === "string" ? run.anchorAt : null,
      selfBuiltAccumulatedDays: coverageDays,
      selfBuiltTargetDays: 28,
      selfBuiltProgressLabel: `${coverageDays === null ? "未知" : coverageDays}/28天`,
      selfBuiltCoverageStatus: String(derived.coverageStatus || "no_data"),
      sourceRunIds: Array.isArray(derived.sourceRunIds) ? derived.sourceRunIds : [],
      windowBasis: derived.windowBasis || "尚无可用Seller批次；不从Wordstat报告沿用静态覆盖数",
      contextSource: "onzo_live_seller_tables",
      promoAutoDecision: false,
    },
  };
}

async function existingReport(db: DbAdapter, report: WeeklyReport): Promise<Record<string, unknown> | undefined> {
  const rows = await db.all<Record<string, unknown>>("SELECT * FROM wordstat_weekly_reports WHERE idempotency_key=? OR report_id=? LIMIT 1", [report.idempotencyKey, report.reportId]);
  return rows[0];
}

export async function syncWordstatWeekly(options: SyncOptions): Promise<Record<string, unknown>> {
  const bucket = options.bucket || process.env.WORDSTAT_CLOUD_BUCKET;
  if (!bucket) throw new Error("WORDSTAT_CLOUD_BUCKET is required for Wordstat cloud sync");
  const manifestKey = options.manifestKey || "wordstat-weekly/reports/v1/manifest_latest_attempt.json";
  const manifestRaw = await options.client.getObject(bucket, manifestKey);
  if (!manifestRaw) return { status: "NO_REPORT", idempotent: false, notificationStatus: "not_sent" };
  const manifest = JSON.parse(manifestRaw.toString("utf8")) as Record<string, unknown>;
  const reportKey = requiredText(manifest.latestReportKey, "latestReportKey", 1024);
  if (!reportKey.startsWith("wordstat-weekly/")) throw new Error("Report key is outside the allowed Wordstat prefix");
  const expectedSha256 = requiredText(manifest.reportSha256, "reportSha256", 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("Report SHA-256 is invalid");
  const expectedLength = Number(manifest.reportByteLength);
  if (!Number.isInteger(expectedLength) || expectedLength < 1) throw new Error("Report byte length is invalid");
  const raw = await options.client.getObject(bucket, reportKey);
  if (!raw) throw new Error("Report object is missing; do not replace it with empty data");
  const actualSha256 = createHash("sha256").update(raw).digest("hex");
  if (raw.length !== expectedLength || actualSha256 !== expectedSha256) throw new Error("Report readback byte length or SHA-256 mismatch");
  const report = await withLiveSellerContext(options.db, validateWeeklyReport(JSON.parse(raw.toString("utf8"))));
  if (options.dryRun) return { status: "DRY_RUN", reportId: report.reportId, sourceAsOf: report.globalSourceAsOfMax, sellerValidationContext: report.sellerValidationContext, card: buildWordstatWeeklyCard(report), databaseWritten: false, notificationSent: false };
  const existing = await existingReport(options.db, report);
  if (existing) {
    if (existing.raw_sha256 !== actualSha256) throw new Error("Existing report hash differs from the new object");
    return { status: report.overallStatus, reportId: report.reportId, idempotent: true, notificationStatus: existing.notification_status, sourceAsOf: report.globalSourceAsOfMax, rawSha256: actualSha256 };
  }
  const now = new Date().toISOString();
  try {
    await options.db.run(
      `INSERT INTO wordstat_weekly_reports (report_id,idempotency_key,overall_status,source_as_of,generated_at,raw_sha256,storage_bucket,storage_key,report_json,notification_status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [report.reportId, report.idempotencyKey, report.overallStatus, report.globalSourceAsOfMax, report.generatedAt, actualSha256, bucket, reportKey, JSON.stringify(report), "pending", now],
    );
  } catch (error) {
    const duplicate = (error as { code?: string }).code === "23505" || /unique/i.test((error as Error).message);
    if (!duplicate) throw error;
    const saved = await existingReport(options.db, report);
    if (!saved || saved.raw_sha256 !== actualSha256) throw error;
    return { status: report.overallStatus, reportId: report.reportId, idempotent: true, notificationStatus: saved.notification_status, sourceAsOf: report.globalSourceAsOfMax, rawSha256: actualSha256 };
  }

  const send = options.notify || ((card, correlationId) => notifier.sendFeishuCard(card, correlationId));
  let notificationStatus = "SENT";
  let notificationError: string | null = null;
  try {
    const accepted = await send(buildWordstatWeeklyCard(report), report.reportId);
    if (!accepted) {
      notificationStatus = "NOT_SENT_OR_UNCERTAIN";
      notificationError = "飞书未配置或发送未确认；不自动重试，避免重复卡片";
    }
  } catch (error) {
    notificationStatus = "UNCERTAIN";
    notificationError = (error as Error).message.slice(0, 500);
  }
  await options.db.run("UPDATE wordstat_weekly_reports SET notification_status=?,notification_error=?,notified_at=? WHERE report_id=?", [notificationStatus, notificationError, notificationStatus === "SENT" ? new Date().toISOString() : null, report.reportId]);
  return { status: report.overallStatus, reportId: report.reportId, idempotent: false, notificationStatus, sourceAsOf: report.globalSourceAsOfMax, rawSha256: actualSha256 };
}

export async function latestWordstatWeekly(db: DbAdapter): Promise<Record<string, unknown> | null> {
  const rows = await db.all<Record<string, unknown>>("SELECT * FROM wordstat_weekly_reports ORDER BY created_at DESC LIMIT 1");
  if (!rows.length) return null;
  const row = rows[0];
  const report = await withLiveSellerContext(db, validateWeeklyReport(JSON.parse(String(row.report_json))));
  return {
    ...report,
    storage: { bucket: row.storage_bucket, key: row.storage_key, sha256: row.raw_sha256 },
    notification: { status: row.notification_status, error: row.notification_error, notifiedAt: row.notified_at },
    persistedAt: row.created_at,
  };
}
