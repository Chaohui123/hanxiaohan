import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncWordstatWeekly, validateWeeklyReport } from "../src/services/wordstat-weekly.js";
import { buildWordstatWeeklyCard } from "../src/services/wordstat-weekly-card.js";
import { SEARCH_ANALYTICS_DDL } from "../src/db/search-analytics-schema.js";

function report(status = "success") {
  return {
    reportId: "run-weekly-test",
    idempotencyKey: "2026-W46:test:v1",
    eventId: "timer-event-test",
    overallStatus: status,
    globalSourceAsOfMax: "2026-09-28",
    generatedAt: new Date().toISOString(),
    runDate: "2026-11-16",
    top10Observations: [{
      phrase: "вакуумные пакеты для одежды",
      zhDraft: "衣物压缩收纳袋 [辅助阅读草稿]",
      effectiveWeeklyVolume: 3149,
      wowRate: 0.2,
      score: { observationPriorityScore: null, scoreStatus: "stale_hold", explanation: ["过期不评分"] },
      referenceCities: [{ nameZh: "莫斯科", rawShare: 0.000171, affinityIndex: 158.787 }],
      seasonality: { status: "stale_or_missing_series", uncertaintyNote: "缺周不预测" },
      yandexSearchUrl: "https://yandex.ru/search/?text=test",
      ozonSearchUrl: "https://www.ozon.ru/search/?text=test",
    }],
    failedRequests: status === "failed_alert_only" ? [{ phrase: "test", errorType: "OUTCOME_UNKNOWN", httpStatus: null, message: "不自动重试" }] : [],
    sellerValidationContext: { selfBuiltProgressLabel: "7/28天", promoAutoDecision: false },
    disclaimers: ["仅作观察，不上架"],
    rawReceiptKeys: ["wordstat-weekly/raw/test.json"],
  };
}

class FakeDb {
  rows: Array<Record<string, unknown>> = [];
  sellerRuns: Array<Record<string, unknown>> = [];
  async all(sql: string, params: unknown[] = []) {
    if (sql.includes("FROM ozon_search_collection_runs")) return this.sellerRuns;
    if (sql.includes("ORDER BY created_at DESC")) return this.rows.slice(-1);
    return this.rows.filter(row => row.idempotency_key === params[0] || row.report_id === params[1]);
  }
  async run(sql: string, params: unknown[]) {
    if (sql.startsWith("INSERT")) {
      const keys = ["report_id", "idempotency_key", "overall_status", "source_as_of", "generated_at", "raw_sha256", "storage_bucket", "storage_key", "report_json", "notification_status", "created_at"];
      const row = Object.fromEntries(keys.map((key, index) => [key, params[index]]));
      if (this.rows.some(existing => existing.idempotency_key === row.idempotency_key)) {
        const error = new Error("UNIQUE constraint failed") as Error & { code?: string };
        error.code = "23505";
        throw error;
      }
      this.rows.push(row);
    } else if (sql.startsWith("UPDATE")) {
      const row = this.rows.find(item => item.report_id === params[3]);
      if (row) Object.assign(row, { notification_status: params[0], notification_error: params[1], notified_at: params[2] });
    }
  }
}

function clientFor(payload: Record<string, unknown>, corrupt = false) {
  const raw = Buffer.from(JSON.stringify(payload));
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const manifest = {
    latestReportKey: "wordstat-weekly/reports/v1/2026-W46/report_test.json",
    reportSha256: sha256,
    reportByteLength: raw.length,
    overallStatus: payload.overallStatus,
  };
  return {
    getObject: async (_bucket: string, key: string) => {
      if (key.endsWith("manifest_latest_attempt.json")) return Buffer.from(JSON.stringify(manifest));
      if (key === manifest.latestReportKey) return corrupt ? Buffer.concat([raw, Buffer.from(" ")]) : raw;
      return null;
    },
  };
}

beforeEach(() => {
  vi.stubEnv("WORDSTAT_CLOUD_BUCKET", "onzo-test-bucket");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Wordstat weekly cloud sync", () => {
  it("validates, persists and notifies exactly once", async () => {
    const db = new FakeDb();
    db.sellerRuns.push({ run_id: "seller-current", company_id: "5140601", status: "succeeded", filter_hash: "all", anchor_at: "2026-11-14T05:47:08.000Z", native_period: "days_7", manifest_json: JSON.stringify({ nativePeriod: { requested: "days_7" } }), page_count: 198, row_count: 9900 });
    const notify = vi.fn().mockResolvedValue(true);
    const input = report();
    const first = await syncWordstatWeekly({ client: clientFor(input), db: db as never, notify });
    expect(first.idempotent).toBe(false);
    expect(first.notificationStatus).toBe("SENT");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(db.rows).toHaveLength(1);
    const saved = JSON.parse(String(db.rows[0].report_json));
    expect(saved.sellerValidationContext.nativeBatchPages).toBe(198);
    expect(saved.sellerValidationContext.nativeBatchRows).toBe(9900);
    expect(saved.sellerValidationContext.contextSource).toBe("onzo_live_seller_tables");
    expect(saved.sellerValidationContext.selfBuiltProgressLabel).toBe("7/28天");
    expect(saved.sellerValidationContext.sourceRunIds).toEqual(["seller-current"]);
    const second = await syncWordstatWeekly({ client: clientFor(input), db: db as never, notify });
    expect(second.idempotent).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(db.rows).toHaveLength(1);
  });

  it("dry-run builds a card without database or notification writes", async () => {
    const db = new FakeDb();
    const notify = vi.fn();
    const result = await syncWordstatWeekly({ client: clientFor(report()), db: db as never, dryRun: true, notify });
    expect(result.status).toBe("DRY_RUN");
    expect(result.databaseWritten).toBe(false);
    expect(result.notificationSent).toBe(false);
    expect((result.card as { msg_type: string }).msg_type).toBe("interactive");
    expect(JSON.stringify(result.card)).toContain("本次没有有效评分Top10");
    expect((result.sellerValidationContext as Record<string, unknown>).selfBuiltProgressLabel).toBe("未知/28天");
    expect((result.sellerValidationContext as Record<string, unknown>).nativeBatchPages).toBeNull();
    expect(db.rows).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("rejects corrupted report bytes before any write", async () => {
    const db = new FakeDb();
    await expect(syncWordstatWeekly({ client: clientFor(report(), true), db: db as never, notify: vi.fn() })).rejects.toThrow("SHA-256");
    expect(db.rows).toHaveLength(0);
  });

  it("builds a red alert card for a failed report without hiding the gap", async () => {
    const card = buildWordstatWeeklyCard(validateWeeklyReport(report("failed_alert_only")));
    expect((card.card as { header: { template: string } }).header.template).toBe("red");
    expect(JSON.stringify(card)).toContain("OUTCOME_UNKNOWN");
    expect(JSON.stringify(card)).toContain("不自动");
  });

  it("rejects missing idempotency fields before any database write", async () => {
    const input = report();
    delete (input as Record<string, unknown>).idempotencyKey;
    const db = new FakeDb();
    const notify = vi.fn();
    await expect(syncWordstatWeekly({ client: clientFor(input), db: db as never, notify })).rejects.toThrow("idempotencyKey");
    expect(db.rows).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not mark an unconfirmed webhook result as sent", async () => {
    const db = new FakeDb();
    const result = await syncWordstatWeekly({ client: clientFor(report()), db: db as never, notify: vi.fn().mockResolvedValue(false) });
    expect(result.notificationStatus).toBe("NOT_SENT_OR_UNCERTAIN");
    expect(db.rows[0].notification_status).toBe("NOT_SENT_OR_UNCERTAIN");
  });

  it("keeps a compatible table definition in the existing schema", () => {
    expect(SEARCH_ANALYTICS_DDL).toContain("CREATE TABLE IF NOT EXISTS wordstat_weekly_reports");
    expect(SEARCH_ANALYTICS_DDL).toContain("idempotency_key TEXT UNIQUE NOT NULL");
  });
});

describe("Feishu interactive card delivery", () => {
  it("uses the existing signature convention and never performs a real test webhook call", async () => {
    vi.stubEnv("NOTIFY_FEISHU_WEBHOOK", "https://open.feishu.cn/test-only");
    vi.stubEnv("NOTIFY_FEISHU_SECRET", "synthetic-test-secret");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ code: 0 }) });
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
    const { Notifier } = await import("../src/services/notifier.js");
    const card = buildWordstatWeeklyCard(validateWeeklyReport(report()));
    await expect(new Notifier().sendFeishuCard(card, "weekly-test")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0][1];
    const body = JSON.parse(request.body);
    expect(body.msg_type).toBe("interactive");
    expect(body.timestamp).toBeDefined();
    expect(body.sign).toBeDefined();
  });
});
