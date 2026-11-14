import { useQuery } from "@tanstack/react-query";
import { api } from "./client";

export type SearchRun = {
  runId: string;
  companyId: string;
  status: string;
  sourceDependency: string;
  nativePeriod: { requested: string; label?: string; start: string | null; end: string | null; timezone: string | null; basis?: string };
  anchorAt: string | null;
  rowCount: number;
  pageCount: number;
  expectedPages: number;
  contentSha256: string | null;
  errorCode: string | null;
  error: string | null;
  finishedAt: string | null;
};

export type SearchQueryRow = {
  query: string;
  rawMetrics: Record<string, unknown>;
  dynamic28: number | null;
  dynamic7: number | null;
  collectedAt: string;
  sourceRunId: string;
  [key: string]: unknown;
};

export type DerivedValue = {
  value: number | null;
  reason: string | null;
  weeklyValues: Array<{ runId: string; anchorAt: string; value: number | null; present: boolean }>;
};

export type DerivedQueryRow = {
  query: string;
  metrics: Record<string, DerivedValue>;
  weekly: Array<{ runId: string; anchorAt: string; metrics: Record<string, unknown> | null }>;
};

export type SearchQueryResponse = {
  window: number;
  sourceType: string;
  items: SearchQueryRow[] | DerivedQueryRow[];
  total: number;
  page: number;
  pageSize: number;
  run?: SearchRun | null;
  coverageStatus?: string;
  coverageDays?: number;
  sourceRunIds?: string[];
  sourceRuns?: Array<{ run_id: string; anchor_at: string }>;
  algorithmVersion?: string;
  windowBasis?: string;
  reason?: string;
  note?: string;
};

export type SearchRunsResponse = {
  items: SearchRun[];
  lastAttempt: SearchRun | null;
  lastSuccess: SearchRun | null;
  stale: boolean;
  sourceDependency: string;
  note: string;
};

export type SelectionCandidate = {
  rank_in_batch: number;
  query: string;
  cn_gloss_draft: string;
  form_hypothesis_draft: string;
  manual_review_flags: string;
  primary_quadrant: string;
  all_matched_quadrants: string;
  Opportunity_Score: number | null;
  score_status: string;
  data_quality_status: string;
  risk_flags: string;
  count: number | null;
  usersWithoutInterectionShare: number | null;
  ca: number | null;
  ord: number | null;
  searchUsersToOrdUsers: number | null;
  avgCaRub: number | null;
  uniqSellers: number | null;
  zrShare: number | null;
  ozon_search_url: string;
  yandex_search_url: string;
  wordstat_url: string;
  mandatory_pending_actions: string;
};

export type SelectionResponse = {
  algorithmVersion: string;
  runId: string;
  anchorAt: string | null;
  hash: string;
  run: { runId: string; anchorAt: string | null; pageCount: number | null; expectedPages: number | null; rowCount: number; contentSha256: string };
  configHash: string;
  filterFunnel: {
    rawRows: number; invalidRows: number; exactDuplicatesRemoved: number; governanceFiltered: number;
    deduplicatedRows: number; eligibleRows: number; top30Actual: number; conservedRows: number;
  };
  quadrantCounts: Record<string, number>;
  top30: SelectionCandidate[];
  wordstat: { status: "NOT_REQUESTED" };
  note: string;
  mandatoryPendingActions: string;
};

export type SearchParams = {
  window: "7" | "28";
  query: string;
  page: number;
  pageSize: number;
  sort: string;
  direction: "asc" | "desc";
};

export type TrendResponse = {
  items: Array<{ runId: string; collectedAt: string; metrics: Record<string, unknown>; overlapsPrevious: boolean }>;
  note: string;
};

export const searchAnalyticsApi = {
  queries: (params: SearchParams) => api.get("/api/search-analytics/queries", { params }) as unknown as Promise<SearchQueryResponse>,
  runs: () => api.get("/api/search-analytics/runs") as unknown as Promise<SearchRunsResponse>,
  trend: (query: string) => api.get("/api/search-analytics/queries/trend", { params: { query, days: 90 } }) as unknown as Promise<TrendResponse>,
  exportFile: (params: SearchParams, format: "csv" | "xlsx") => api.get("/api/search-analytics/export", { params: { ...params, format }, responseType: "blob" }) as unknown as Promise<Blob>,
  selection: (runId?: string) => api.get("/api/search-analytics/selection", { params: runId ? { runId } : {} }) as unknown as Promise<SelectionResponse>,
  selectionExport: (runId: string) => api.get("/api/search-analytics/selection/export", { params: { runId }, responseType: "blob" }) as unknown as Promise<Blob>,
};

export function useSearchQueries(params: SearchParams) {
  return useQuery({
    queryKey: ["search-analytics", "queries", params],
    queryFn: () => searchAnalyticsApi.queries(params),
    placeholderData: previous => previous,
  });
}

export function useSearchRuns() {
  return useQuery({ queryKey: ["search-analytics", "runs"], queryFn: searchAnalyticsApi.runs, refetchInterval: 60_000 });
}

export function useSearchTrend(query: string) {
  return useQuery({ queryKey: ["search-analytics", "trend", query], queryFn: () => searchAnalyticsApi.trend(query), enabled: Boolean(query) });
}

export function useSelectionCandidates(enabled: boolean, runId?: string) {
  return useQuery({
    queryKey: ["search-analytics", "selection", runId || "current"],
    queryFn: () => searchAnalyticsApi.selection(runId),
    enabled,
  });
}
