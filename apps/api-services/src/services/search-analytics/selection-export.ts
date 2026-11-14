import type { AnalysisRow, SelectionAnalysis } from "./selection-analyzer.js";
import { GOVERNANCE_BOUNDARIES } from "./selection-analyzer.js";

export const TOP_COLUMNS = [
  "rank_in_batch", "query", "token_cluster_id", "cluster_size_in_batch",
  "cn_gloss_draft", "form_hypothesis_draft", "manual_review_flags",
  "primary_quadrant", "all_matched_quadrants", "Opportunity_Score", "score_status", "data_quality_status", "evidence_status", "count",
  "usersWithoutInterectionShare", "ca", "ord", "searchUsersToOrdUsers", "avgCaRub", "uniqSellers", "zrShare", "gmv", "ws_count", "ws_status",
  "ws_sourceAsOf_and_window", "max_total_cost_rub_15pct", "max_total_cost_rub_10pct", "economics_gate_status", "economics_pending_inputs",
  "content_gate_status", "ozon_search_url", "yandex_search_url", "wordstat_url", "mandatory_pending_actions",
] as const;
export const DETAIL_COLUMNS = [
  "original_row_id", "query", "query_norm", "token_cluster_id", "cluster_size_in_batch", "primary_quadrant", "all_matched_quadrants",
  "sub_pool_reason", "quadrant_hypothesis_note", "Opportunity_Score", "S_heat", "S_no_int", "S_ca", "S_price", "active_weight_sum", "score_status",
  "data_quality_status", "risk_flags", "top30_eligible", "top30_exclusion_reason", "evidence_status", "count", "uniqQueriesWCa", "ca", "ord",
  "searchUsersToOrdUsers", "gmv", "avgCaRub", "avgCaRub_effective", "price_obs_status", "itemsViews", "uniqSellers", "usersWithoutInterectionCount",
  "usersWithoutInterectionShare", "zrCount", "zrShare", "dynamic7", "dynamic28", "ws_count", "ws_status", "ws_sourceAsOf", "ws_periodWindow",
  "ws_receiptHash", "fbs_price_band_flag", "max_total_cost_rub_10pct", "max_total_cost_rub_15pct", "economics_gate_status", "economics_pending_inputs",
  "content_gate_status", "cn_gloss_draft", "form_hypothesis_draft", "translation_override_status", "manual_review_flags", "ozon_search_url",
  "yandex_search_url", "wordstat_url", "mandatory_pending_actions",
] as const;
export const FILTER_COLUMNS = [
  "original_row_id", "query", "filter_category", "all_filter_categories", "matched_rule_id", "matched_keyword_or_pattern", "filter_explanation",
  "count", "ca", "ord", "avgCaRub", "usersWithoutInterectionShare", "governance_audit_json",
] as const;
export const QUARANTINE_COLUMNS = ["original_row_id", "raw_query", "isolation_type", "isolation_detail", "kept_master_row_id", "raw_row_json_snapshot"] as const;
const URL_COLUMNS: Record<string, string> = { ozon_search_url: "Ozon调研", yandex_search_url: "Yandex调研", wordstat_url: "Wordstat调研" };
const PERCENT_FIELDS = new Set(["ca", "searchUsersToOrdUsers", "usersWithoutInterectionShare", "zrShare", "dynamic7", "dynamic28"]);
const SCORE_FIELDS = new Set(["Opportunity_Score", "S_heat", "S_no_int", "S_ca", "S_price", "active_weight_sum"]);
const DECIMAL_FIELDS = new Set(["count", "gmv", "avgCaRub", "avgCaRub_effective", "ord", "uniqSellers"]);

function excelSafeString(input: string): string {
  const value = Array.from(input).filter(character => {
    const code = character.charCodeAt(0);
    return !(code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31));
  }).join("");
  return /^[=+\-@]/.test(value.trimStart()) ? `'${value}` : value;
}
function excelValue(value: unknown): string | number | boolean {
  if (value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value))) return "N/A";
  if (typeof value === "object") return excelSafeString(JSON.stringify(value));
  if (typeof value === "string") return excelSafeString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  return excelSafeString(String(value));
}
function metadataRows(manifest: Record<string, unknown>): AnalysisRow[] {
  const rows: AnalysisRow[] = [];
  const visit = (value: unknown, parts: string[]): void => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, item] of Object.entries(value)) visit(item, [...parts, key]);
      return;
    }
    rows.push({ original_row_id: rows.length + 2, query: "", section: parts[0] || "root", key: parts.join("."), value: Array.isArray(value) ? JSON.stringify(value) : value });
  };
  visit(manifest, []);
  for (const boundary of GOVERNANCE_BOUNDARIES) rows.push({ original_row_id: rows.length + 2, query: "", section: "governanceBoundary", key: "非授权与口径边界", value: boundary });
  return rows;
}

export async function buildSelectionWorkbook(analysis: SelectionAnalysis): Promise<Buffer> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  const append = (name: string, rows: AnalysisRow[], columns: readonly string[], warning?: string): void => {
    const headerRow = warning ? 2 : 1;
    const values: unknown[][] = [];
    if (warning) values.push([excelSafeString(warning)]);
    values.push([...columns]);
    for (const row of rows) values.push(columns.map(column => URL_COLUMNS[column] ? (row[column] ? URL_COLUMNS[column] : "N/A") : excelValue(row[column])));
    const sheet = XLSX.utils.aoa_to_sheet(values);
    sheet["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(headerRow - 1, values.length - 1), c: Math.max(0, columns.length - 1) } });
    if (warning) sheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: Math.max(0, columns.length - 1) } }];
    sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: headerRow - 1, c: 0 }, e: { r: Math.max(headerRow - 1, values.length - 1), c: Math.max(0, columns.length - 1) } }) };
    sheet["!cols"] = columns.map(column => ({ wch: ["query", "cn_gloss_draft", "form_hypothesis_draft", "mandatory_pending_actions", "economics_pending_inputs", "filter_explanation", "isolation_detail"].includes(column) ? 42 : Math.min(60, Math.max(12, column.length + 2)) }));
    rows.forEach((row, rowIndex) => columns.forEach((column, columnIndex) => {
      const address = XLSX.utils.encode_cell({ r: headerRow - 1 + rowIndex + 1, c: columnIndex });
      const cell = sheet[address] as { v?: unknown; z?: string; l?: { Target: string } } | undefined;
      if (!cell) return;
      if (URL_COLUMNS[column] && row[column]) cell.l = { Target: String(row[column]) };
      if (typeof cell.v === "number") {
        if (PERCENT_FIELDS.has(column)) cell.z = '0.00"%"';
        else if (SCORE_FIELDS.has(column)) cell.z = "0.0000";
        else if (DECIMAL_FIELDS.has(column)) cell.z = "#,##0.00";
      }
    }));
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  };
  append("00_批次口径与回执元数据", metadataRows(analysis.manifest), ["section", "key", "value"], "只读分析；days_7口径；非任何生产或经营动作授权");
  append("Top30_立项推荐", analysis.top30, TOP_COLUMNS, "仅作调研排序待核 · 非立项/采购/上架授权 · 不足30条按实输出绝不伪造");
  append("四象限分类明细", analysis.detail, DETAIL_COLUMNS);
  append("品牌词过滤记录", analysis.filtered, FILTER_COLUMNS);
  append("不合格与异常隔离", analysis.quarantine, QUARANTINE_COLUMNS);
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
