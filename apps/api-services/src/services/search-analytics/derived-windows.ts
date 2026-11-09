import { createHash } from "node:crypto";
import type { DbAdapter } from "../../db/connection.js";
import { SEARCH_METRICS } from "./metric-definitions.js";

export const DERIVED_WINDOW_ALGORITHM = "four-native-7d-anchor-windows-v1";
const WEEK_MS = 7 * 86_400_000;
const MAX_CLOCK_GAP_MS = 15 * 60_000;

type RunRow = {
  run_id: string;
  company_id: string;
  filter_hash: string;
  anchor_at: string;
  native_period: string;
};

export type DerivedRunSelection = {
  runs: RunRow[];
  coverageStatus: "insufficient_history" | "complete";
  coverageDays: number;
  algorithmVersion: string;
  windowBasis: string;
};

export function selectWeeklyRuns(rows: RunRow[], companyId: string, filterHash: string): DerivedRunSelection {
  const candidates = rows
    .filter(row => row.company_id === companyId && row.filter_hash === filterHash && row.native_period === "days_7")
    .filter(row => Number.isFinite(Date.parse(row.anchor_at)))
    .sort((a, b) => Date.parse(b.anchor_at) - Date.parse(a.anchor_at));
  const selected: RunRow[] = [];
  if (candidates[0]) selected.push(candidates[0]);
  while (selected.length < 4) {
    const latest = selected[selected.length - 1];
    const anchor = Date.parse(latest.anchor_at);
    const next = candidates.find(row => {
      const time = Date.parse(row.anchor_at);
      return time <= anchor - WEEK_MS && time >= anchor - WEEK_MS - MAX_CLOCK_GAP_MS;
    });
    if (!next) break;
    selected.push(next);
  }
  return {
    runs: selected,
    coverageStatus: selected.length === 4 ? "complete" : "insufficient_history",
    coverageDays: selected.length * 7,
    algorithmVersion: DERIVED_WINDOW_ALGORITHM,
    windowBasis: "Ozon days_7窗口按各页服务端采集时间锚定；接口未返回自然日边界或时区，不冒充官方自然日28天",
  };
}

async function selectRuns(db: DbAdapter, companyId: string, filterHash?: string): Promise<DerivedRunSelection> {
  const rows = await db.all<RunRow>(
    `SELECT run_id, company_id, filter_hash, anchor_at, native_period FROM ozon_search_collection_runs
     WHERE status='succeeded' AND company_id=? AND anchor_at IS NOT NULL ORDER BY anchor_at DESC LIMIT 400`,
    [companyId],
  );
  const latest = rows[0];
  return selectWeeklyRuns(rows, companyId, filterHash || latest?.filter_hash || "");
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function buildDerivedWindow(db: DbAdapter, selection: DerivedRunSelection, persist: boolean): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {
    window: 28, sourceType: "derived_28_from_four_native_7d",
    coverageStatus: selection.coverageStatus, coverageDays: selection.coverageDays,
    sourceRunIds: selection.runs.map(run => run.run_id), sourceRuns: selection.runs,
    algorithmVersion: selection.algorithmVersion, windowBasis: selection.windowBasis,
    calendarStart: null, calendarEnd: null,
    items: [], total: 0,
  };
  if (selection.coverageStatus !== "complete") {
    result.reason = "需要四个连续、不重叠的原生7天窗口；每天相邻滚动报表不直接相加";
    return result;
  }
  const runIds = selection.runs.map(run => run.run_id);
  const rows = await db.all<Record<string, unknown>>(
    `SELECT * FROM ozon_search_query_snapshots WHERE run_id IN (${runIds.map(() => "?").join(",")}) ORDER BY query_text, collected_at DESC`,
    runIds,
  );
  const byQuery = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const query = String(row.query_text);
    const list = byQuery.get(query) || [];
    list.push(row);
    byQuery.set(query, list);
  }
  const items = [...byQuery.entries()].map(([query, sourceRows]) => {
    const metrics: Record<string, unknown> = {};
    for (const metric of SEARCH_METRICS.filter(item => item.column && item.column !== "seasonality_json")) {
      const weeklyValues = selection.runs.map(run => {
        const row = sourceRows.find(item => item.run_id === run.run_id);
        return { runId: run.run_id, anchorAt: run.anchor_at, value: row ? numeric(row[metric.column]) : null, present: Boolean(row) };
      });
      let value: number | null = null;
      let reason = metric.reason || null;
      if (metric.aggregation === "latest") {
        value = weeklyValues[0].present ? weeklyValues[0].value : null;
        if (!weeklyValues[0].present) reason = "missing_latest_observation_not_zero";
      } else if (metric.aggregation === "sum") {
        value = weeklyValues.every(item => item.present && item.value !== null)
          ? weeklyValues.reduce((sum, item) => sum + (item.value || 0), 0)
          : null;
        if (value === null) reason = "missing_query_in_source_window_not_zero";
      } else {
        reason = reason || "metric_not_computable_across_weeks";
      }
      metrics[metric.field] = { value, weeklyValues, reason };
    }
    return {
      query,
      metrics,
      weekly: selection.runs.map(run => {
        const row = sourceRows.find(item => item.run_id === run.run_id);
        let rawMetrics: unknown = null;
        if (row) rawMetrics = JSON.parse(String(row.metrics_json));
        return { runId: run.run_id, anchorAt: run.anchor_at, metrics: rawMetrics };
      }),
    };
  });
  result.items = items;
  result.total = items.length;
  if (persist) {
    await db.run("DELETE FROM ozon_search_derived_windows WHERE company_id=? AND anchor_at=? AND algorithm_version=?", [selection.runs[0].company_id, selection.runs[0].anchor_at, DERIVED_WINDOW_ALGORITHM]);
    for (const item of items) {
      await db.run(
        `INSERT INTO ozon_search_derived_windows
         (derived_id,company_id,anchor_at,coverage_status,source_run_ids_json,algorithm_version,query_text,metrics_json,reasons_json)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          createHash("sha256").update(`${selection.runs[0].company_id}\0${selection.runs[0].anchor_at}\0${DERIVED_WINDOW_ALGORITHM}\0${item.query}`).digest("hex"),
          selection.runs[0].company_id, selection.runs[0].anchor_at, selection.coverageStatus,
          JSON.stringify(runIds), DERIVED_WINDOW_ALGORITHM, item.query,
          JSON.stringify(item.metrics), JSON.stringify({ windowBasis: selection.windowBasis, weekly: item.weekly }),
        ],
      );
    }
  }
  return result;
}

export async function refreshDerivedWindow(db: DbAdapter, companyId: string, filterHash?: string): Promise<Record<string, unknown>> {
  const selection = await selectRuns(db, companyId, filterHash);
  return buildDerivedWindow(db, selection, true);
}

export async function getDerivedWindow(db: DbAdapter, companyId: string): Promise<Record<string, unknown>> {
  const selection = await selectRuns(db, companyId);
  if (selection.coverageStatus !== "complete") return buildDerivedWindow(db, selection, false);
  const count = await db.all<{ count: number | string }>(
    "SELECT COUNT(*) AS count FROM ozon_search_derived_windows WHERE company_id=? AND anchor_at=? AND algorithm_version=?",
    [companyId, selection.runs[0].anchor_at, DERIVED_WINDOW_ALGORITHM],
  );
  const persisted = Number(count[0]?.count) > 0;
  return buildDerivedWindow(db, selection, false).then(result => ({ ...result, persisted }));
}
