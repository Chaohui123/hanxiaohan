import { useQuery } from "@tanstack/react-query";
import { api, unwrapData } from "./client";

export type WeeklyObservation = {
  phrase: string;
  zhDraft: string;
  effectiveWeeklyVolume: number | null;
  wowRate: number | null;
  sourceAsOf: string | null;
  lagDaysFromRun: number | null;
  freshnessStatus: string;
  score: { observationPriorityScore: number | null; scoreStatus: string; explanation: string[] };
  referenceCities: Array<{ nameZh: string; rawShare: number | null; affinityIndex: number | null }>;
  seasonality: { status: string; uncertaintyNote: string; estimatedDaysBand?: number[] | null };
  warnings: string[];
  dailyGapFill?: {
    status: string;
    sourceAsOf: string | null;
    returnedPointsCount: number;
    missingCalendarDays: number | null;
    targetThroughDate: string | null;
    note: string;
  } | null;
  yandexSearchUrl: string;
  ozonSearchUrl: string;
};

export type WordstatWeeklyReport = {
  reportId: string;
  overallStatus: "success" | "degraded_partial" | "failed_alert_only";
  runDate: string;
  generatedAt: string;
  globalSourceAsOfMax: string | null;
  latestDailySourceAsOf?: string | null;
  wordstatWatermark?: {
    sourceAsOf: string | null;
    observedSourceAsOf: string | null;
    lastCheckedAt: string;
    responseHash: string;
    status: string;
    triggerReason: string;
    lastFullReportId: string | null;
  } | null;
  top10Observations: WeeklyObservation[];
  failedRequests: Array<{ phrase: string; errorType: string; httpStatus: number | null; message: string }>;
  sellerValidationContext: {
    selfBuiltProgressLabel: string;
    selfBuiltCoverageStatus?: string;
    nativeWindowDays: number | null;
    nativeBatchPages: number | null;
    nativeBatchRows: number | null;
    nativeBatchCollectedAt: string | null;
    contextSource?: string;
    promoAutoDecision: false;
  };
  disclaimers: string[];
  rawReceiptKeys: string[];
  storage?: { bucket: string; key: string; sha256: string };
  notification?: { status: string; error: string | null; notifiedAt: string | null };
};

export const wordstatWeeklyApi = {
  latest: () => unwrapData<WordstatWeeklyReport | null>(api.get("/api/yandex-cloud/wordstat/weekly/latest") as unknown as Promise<{ data: WordstatWeeklyReport | null }>),
  preview: () => unwrapData<Record<string, unknown>>(api.post("/api/yandex-cloud/wordstat/weekly/preview", {}) as unknown as Promise<{ data: Record<string, unknown> }>),
};

export function useWordstatWeekly() {
  return useQuery({ queryKey: ["wordstat-weekly", "latest"], queryFn: wordstatWeeklyApi.latest, refetchInterval: 60_000 });
}
