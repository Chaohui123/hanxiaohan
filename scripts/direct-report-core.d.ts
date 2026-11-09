export interface DirectReportRow {
  date: string;
  campaignId: string;
  campaignName: string | null;
  impressions: number;
  clicks: number;
  ctrPercent: number | null;
  avgCpcUsd: number | null;
  costUsd: number;
  conversions: number;
  costPerConversionUsd: number | null;
}

export interface DirectReportSummary {
  from: string | null;
  to: string | null;
  daysWithActivity: number;
  campaignIds: string[];
  impressions: number;
  clicks: number;
  ctrPercent: number | null;
  costUsd: number;
  avgCpcUsd: number | null;
  conversions: number;
  actualCpaUsd: number | null;
  actualCpaNote: string | null;
}

export function parseDirectReportTsv(text: string): DirectReportRow[];
export function summarizeDirectRows(rows: DirectReportRow[], period?: { from?: string; to?: string }): DirectReportSummary;
export function utcDayOffset(day: string, offset: number): string;
