import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { DbAdapter } from "../../db/connection.js";

export const SELECTION_ALGORITHM_VERSION = "seller-days7-selection-ts-v1-python-1.0.0";
export const SELECTION_PROFILE = "days_7_calibrated";
export const MIN_ACTIVE_WEIGHT = 0.65;
export const FIXED_WEIGHTS = { heat: 0.30, no_int: 0.35, ca: 0.25, price: 0.10 } as const;
export const QUADRANT_PRIORITY = ["蓝海缺口", "高转化刚需", "高客单垂类"] as const;
export const REGULAR_QUADRANT = "常规观察池";
export const MANUAL_REVIEW_TOP30_BLOCKERS = ["AMBIGUOUS_IDENTITY", "BRAND_REVIEW_REQUIRED"] as const;

export const NUMERIC_FIELDS = [
  "count", "uniqQueriesWCa", "ca", "ord", "searchUsersToOrdUsers", "gmv", "avgCaRub", "itemsViews",
  "uniqSellers", "usersWithoutInterectionCount", "usersWithoutInterectionShare", "zrCount", "zrShare",
  "dynamic7", "dynamic28",
] as const;
const RATIO_FIELDS = ["ca", "searchUsersToOrdUsers", "usersWithoutInterectionShare", "zrShare"] as const;
const NON_NEGATIVE_FIELDS = NUMERIC_FIELDS.filter(field => field !== "dynamic7" && field !== "dynamic28");
const NULL_TOKENS = new Set(["", "null", "none", "nan", "n/a", "na"]);
const STOPWORDS = new Set(["а", "в", "во", "для", "до", "и", "из", "к", "ко", "на", "над", "не", "о", "об", "от", "по", "под", "при", "с", "со", "у", "за"]);
const AMBIGUOUS_BARE_NOISE_TOKENS = new Set(["фото", "видео", "ремонт"]);
const GOVERNANCE_CATEGORIES = ["terminatedDirections", "existingPortfolioExclusions", "nonPurchaseNoiseTokens", "brandWatchTokens"] as const;
const PENDING_ECONOMICS_INPUTS = "1688实价待核；国内运费待核；包装待核；实测克重与尺寸待核；实际FBS/rFBS仓线待核；类目佣金待核；退货待核；支付待核；实际CPS待核";
export const MANDATORY_PENDING_ACTIONS = `前台真实需求与竞争待核；准确商品身份/变体/关键参数待核；季节窗口与跨境妥投周期待核；合规/禁限运/退货风险待核；${PENDING_ECONOMICS_INPUTS}；持续净利率>=10%才可测、>=15%优先；完整8图+双视频与独立复核未完成前不得上架`;
export const GOVERNANCE_BOUNDARIES = [
  "纯只读分析；所有象限与Top30均为待核假设，非立项、采购、拿样、调价、广告、付费制作或上架授权",
  "count是Ozon Seller days_7搜索查询热度，不是月搜索量、绝对搜索次数或本店SKU漏斗，不跨词累加",
  "avgCaRub是平均价格RUB，不是CPC；不反推搜索人数、无交互人数或其他未返回分子分母",
  "仅适用国内跨境FBS/rFBS；不使用默认25%毛利、不虚构FBO、不以占位费率计算成本上限",
  "Wordstat为NOT_REQUESTED；不补0、不重发、不进入主评分",
  "非购买噪音适配：裸фото/видео/ремонт存在商品语义歧义，保留中央配置但不自动隔离；其他单词仅匹配字面整词，多词词组可用词干组合",
  "NUMERIC_FULL_4D_ONLY仅表示四个评分维度的数值完整，不代表商品身份、合规、供货、经济或商业PASS",
];

const DEFAULT_THRESHOLDS = {
  count_days7_valid_floor: 3774,
  count_days7_niche_min: 5000,
  count_days7_sweet_spot_max: 35000,
  count_days7_broad_head_warn: 50000,
  no_interaction_gap_min_pct: 45,
  no_interaction_dead_bounce_max_pct: 85,
  ca_high_demand_min_pct: 35,
  ca_viable_floor_pct: 15,
  top30_min_search_to_ord_pct: 2,
  ca_high_ticket_min_pct: 18,
  ord_conv_rigid_min_pct: 10,
  ord_commercial_proof_min_buyers: 50,
  ord_rigid_demand_min_buyers: 300,
  avg_price_fbs_viable_floor_rub: 1500,
  avg_price_high_conversion_floor_rub: 1200,
  avg_price_high_ticket_min_rub: 2500,
  avg_price_cross_border_safe_max_rub: 25000,
  avg_price_extreme_outlier_rub: 100000,
  uniq_sellers_low_density_max: 20,
  zr_share_signal_min_pct: 2,
  robust_scale_quantiles: [0.05, 0.95] as [number, number],
};
export type SelectionThresholds = typeof DEFAULT_THRESHOLDS;
type GovernanceCategory = typeof GOVERNANCE_CATEGORIES[number];
type GovernanceRule = { pattern: string; reason: string; category: string; rule_id: string };
type ReviewOverride = { cn_gloss?: unknown; form_hypothesis?: unknown; form?: unknown; review_flags?: unknown };
export type AnalysisRow = Record<string, unknown> & { original_row_id: number; query: string };
export type SelectionRunMetadata = {
  runId: string;
  anchorAt: string | null;
  nativePeriod?: string;
  pages?: unknown[];
  hash: string;
  pageCount?: number | null;
  expectedPages?: number | null;
  rowCount?: number;
  sourceType?: string;
};
export type SelectionAnalysis = {
  manifest: Record<string, unknown>;
  top30: AnalysisRow[];
  detail: AnalysisRow[];
  filtered: AnalysisRow[];
  quarantine: AnalysisRow[];
};
export type RuntimeSelectionConfig = {
  thresholds: SelectionThresholds;
  blacklist: string[];
  governanceRules: Record<GovernanceCategory, GovernanceRule[]>;
  reviewOverrides: Record<string, ReviewOverride>;
  configFiles: Record<"localConfig" | "blacklist" | "centralGovernance" | "reviewOverrides", { fileName: string; sha256: string }>;
  configSha256: string;
};
export type SelectionConfigOptions = {
  root?: string;
  configPath?: string;
  blacklistPath?: string;
  governanceConfigPath?: string;
  reviewOverridesPath?: string;
};

export class SelectionAnalysisError extends Error {
  constructor(message: string, public readonly statusCode = 400, public readonly code = "SELECTION_ANALYSIS_FAILED") {
    super(message);
    this.name = "SelectionAnalysisError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function readYaml(filePath: string): Record<string, unknown> {
  let document: unknown;
  try {
    document = parseYaml(readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new SelectionAnalysisError(`YAML配置读取失败: ${filePath}: ${(error as Error).message}`, 500, "SELECTION_CONFIG_INVALID");
  }
  if (document === null || document === undefined) return {};
  if (!isRecord(document)) throw new SelectionAnalysisError(`YAML顶层必须是对象: ${filePath}`, 500, "SELECTION_CONFIG_INVALID");
  return document;
}

function parseBlacklist(filePath: string): string[] {
  try {
    return readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)
      .map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  } catch (error) {
    throw new SelectionAnalysisError(`黑名单读取失败: ${filePath}: ${(error as Error).message}`, 500, "SELECTION_CONFIG_INVALID");
  }
}

function parseRuleEntries(value: unknown, category: GovernanceCategory, source: string): GovernanceRule[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new SelectionAnalysisError(`governanceRules.${category}必须是列表`, 500, "SELECTION_CONFIG_INVALID");
  const rules: GovernanceRule[] = [];
  value.forEach((item, index) => {
    let pattern: unknown;
    let reason = "命中治理规则";
    if (typeof item === "string") pattern = item;
    else if (isRecord(item) && typeof item.pattern === "string") {
      pattern = item.pattern;
      reason = String(item.reason || reason);
    } else throw new SelectionAnalysisError(`治理规则${category}[${index}]缺少字符串pattern`, 500, "SELECTION_CONFIG_INVALID");
    if (typeof pattern === "string" && pattern.trim()) rules.push({ pattern: pattern.trim(), reason, category, rule_id: `${source}:${category}[${index}]` });
  });
  return rules;
}

function containsWeightOverride(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsWeightOverride);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, item]) => {
    const normalized = key.replace(/_/g, "").toLowerCase();
    return ["weights", "fixedweights", "scoreweights", "countheatweight", "userswithoutinteractionshareweight", "cartconversioncaweight", "avgcarubpriceweight"].includes(normalized) || containsWeightOverride(item);
  });
}

export function normalizeSelectionQuery(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function loadReviewOverrides(document: Record<string, unknown>): Record<string, ReviewOverride> {
  const entries = document.queries ?? document.overrides ?? document;
  if (!isRecord(entries)) throw new SelectionAnalysisError("translation overrides必须是查询词映射或包含queries对象", 500, "SELECTION_CONFIG_INVALID");
  const result: Record<string, ReviewOverride> = {};
  for (const [query, value] of Object.entries(entries)) {
    const key = normalizeSelectionQuery(query);
    if (!key) continue;
    if (typeof value === "string") result[key] = { cn_gloss: value };
    else if (isRecord(value)) {
      parseReviewFlags(value.review_flags);
      result[key] = value;
    } else throw new SelectionAnalysisError(`翻译覆盖项${query}必须是字符串或对象`, 500, "SELECTION_CONFIG_INVALID");
  }
  return result;
}

export function loadSelectionConfig(options: SelectionConfigOptions = {}): RuntimeSelectionConfig {
  const root = path.resolve(options.root || process.env.SEARCH_SELECTION_CONFIG_ROOT || path.resolve(process.cwd(), "tools"));
  const localPath = path.resolve(options.configPath || path.join(root, "ozon-search-analyzer", "config.yaml"));
  const blacklistPath = path.resolve(options.blacklistPath || path.join(root, "ozon-search-analyzer", "blacklist.txt"));
  const centralPath = path.resolve(options.governanceConfigPath || path.join(root, "yandex-wordstat-monitor", "config.yaml"));
  const overridesPath = path.resolve(options.reviewOverridesPath || path.join(root, "ozon-search-analyzer", "review-overrides.yaml"));
  const local = readYaml(localPath);
  const central = readYaml(centralPath);
  const reviewDocument = readYaml(overridesPath);
  if ((local.profile ?? SELECTION_PROFILE) !== SELECTION_PROFILE) throw new SelectionAnalysisError(`仅支持${SELECTION_PROFILE}`, 500, "SELECTION_CONFIG_INVALID");
  if (containsWeightOverride(local)) throw new SelectionAnalysisError("评分权重固定为0.30/0.35/0.25/0.10，禁止任何配置覆盖", 500, "SELECTION_CONFIG_INVALID");
  const configured = local.thresholds ?? {};
  if (!isRecord(configured)) throw new SelectionAnalysisError("config.thresholds必须是对象", 500, "SELECTION_CONFIG_INVALID");
  const unknown = Object.keys(configured).filter(key => !(key in DEFAULT_THRESHOLDS)).sort();
  if (unknown.length) throw new SelectionAnalysisError(`未知阈值参数: ${unknown.join(",")}`, 500, "SELECTION_CONFIG_INVALID");
  const thresholds: SelectionThresholds = { ...DEFAULT_THRESHOLDS, robust_scale_quantiles: [...DEFAULT_THRESHOLDS.robust_scale_quantiles] };
  for (const key of Object.keys(DEFAULT_THRESHOLDS) as Array<keyof SelectionThresholds>) {
    if (!(key in configured)) continue;
    const value = configured[key];
    if (key === "robust_scale_quantiles") {
      if (!Array.isArray(value) || value.length !== 2 || value.some(item => typeof item !== "number" || !Number.isFinite(item))) throw new SelectionAnalysisError("robust_scale_quantiles必须是两个数值", 500, "SELECTION_CONFIG_INVALID");
      const [low, high] = value as number[];
      if (!(0 <= low && low < high && high <= 1)) throw new SelectionAnalysisError("robust_scale_quantiles必须满足0<=P低<P高<=1", 500, "SELECTION_CONFIG_INVALID");
      thresholds.robust_scale_quantiles = [low, high];
    } else {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new SelectionAnalysisError(`阈值${key}必须是有限数值`, 500, "SELECTION_CONFIG_INVALID");
      Object.assign(thresholds, { [key]: value });
    }
  }
  thresholds.no_interaction_dead_bounce_max_pct = Math.min(85, thresholds.no_interaction_dead_bounce_max_pct);
  const governanceRules = {} as Record<GovernanceCategory, GovernanceRule[]>;
  for (const category of GOVERNANCE_CATEGORIES) governanceRules[category] = [];
  for (const [source, document] of [["central", central], ["local", local]] as const) {
    const rules = document.governanceRules ?? {};
    if (!isRecord(rules)) throw new SelectionAnalysisError(`governanceRules必须是对象: ${source}`, 500, "SELECTION_CONFIG_INVALID");
    for (const category of GOVERNANCE_CATEGORIES) governanceRules[category].push(...parseRuleEntries(rules[category], category, source));
  }
  const files = { localConfig: localPath, blacklist: blacklistPath, centralGovernance: centralPath, reviewOverrides: overridesPath };
  const configFiles = {} as RuntimeSelectionConfig["configFiles"];
  for (const [name, filePath] of Object.entries(files) as Array<[keyof typeof files, string]>) {
    let contents: Buffer;
    try { contents = readFileSync(filePath); }
    catch (error) { throw new SelectionAnalysisError(`配置读取失败: ${filePath}: ${(error as Error).message}`, 500, "SELECTION_CONFIG_INVALID"); }
    configFiles[name] = { fileName: path.basename(filePath), sha256: sha256(contents) };
  }
  const configSha256 = sha256(Object.entries(configFiles).map(([name, item]) => `${name}\0${item.sha256}`).join("\n"));
  return {
    thresholds, blacklist: parseBlacklist(blacklistPath), governanceRules,
    reviewOverrides: loadReviewOverrides(reviewDocument), configFiles, configSha256,
  };
}

function isNullNumeric(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && NULL_TOKENS.has(value.trim().toLowerCase())) || (typeof value === "number" && Number.isNaN(value));
}

function parseNumeric(value: unknown): { value: number | null; error: string | null } {
  if (isNullNumeric(value)) return { value: null, error: null };
  if (typeof value === "boolean") return { value: null, error: "布尔值不是数值" };
  let number: number;
  try { number = typeof value === "string" ? Number(value.trim()) : Number(value); }
  catch { return { value: null, error: `非数值: ${String(value)}` }; }
  if (!Number.isFinite(number)) return { value: null, error: `非有限数值: ${String(value)}` };
  return { value: number, error: null };
}

function jsonSafe(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  return value;
}

function cleanRows(rows: Array<Record<string, unknown>>): { valid: AnalysisRow[]; invalid: AnalysisRow[] } {
  const valid: AnalysisRow[] = [];
  const invalid: AnalysisRow[] = [];
  rows.forEach((source, index) => {
    const reasons: string[] = [];
    const details: string[] = [];
    const rawQuery = source.query;
    const query = isNullNumeric(rawQuery) ? "" : String(rawQuery).trim();
    if (!query) { reasons.push("EMPTY_QUERY"); details.push("搜索词为空"); }
    const row = { original_row_id: index + 2, query } as AnalysisRow;
    for (const field of NUMERIC_FIELDS) {
      const parsed = parseNumeric(source[field]);
      row[field] = parsed.value;
      if (parsed.error) { reasons.push("NON_NUMERIC_METRIC"); details.push(`${field}: ${parsed.error}`); }
    }
    const count = row.count as number | null;
    const countNonNumeric = details.some(detail => detail.startsWith("count:"));
    if (count === null && !countNonNumeric) { reasons.push("MISSING_COUNT"); details.push("count必需单元格为空，必须为合法正值"); }
    else if (count !== null && count <= 0) { reasons.push("NON_POSITIVE_COUNT"); details.push("count必须为正值"); }
    for (const field of NON_NEGATIVE_FIELDS) {
      const value = row[field] as number | null;
      if (value !== null && value < 0) { reasons.push("NEGATIVE_METRIC"); details.push(`${field}=${value}为负值`); }
    }
    for (const field of RATIO_FIELDS) {
      const value = row[field] as number | null;
      if (value !== null && !(0 <= value && value <= 100.0001)) { reasons.push("RATIO_OUT_OF_BOUNDS"); details.push(`${field}=${value}超出0..100`); }
    }
    row.raw_query = jsonSafe(rawQuery);
    row.raw_row_json_snapshot = JSON.stringify(Object.fromEntries(["query", ...NUMERIC_FIELDS].map(field => [field, jsonSafe(source[field])])) );
    if (reasons.length) invalid.push({ ...row, isolation_type: [...new Set(reasons)].join("|"), isolation_detail: details.join("；"), kept_master_row_id: null });
    else valid.push(row);
  });
  return { valid, invalid };
}

function foldYo(value: string): string { return value.replace(/ё/g, "е"); }
function queryTokens(value: unknown, fold = true): string[] {
  const text = fold ? foldYo(normalizeSelectionQuery(value)) : normalizeSelectionQuery(value);
  return text.match(/[0-9a-zа-я]+/gu) || [];
}
function tokenClusterKey(query: string): string { return queryTokens(query).map(foldYo).sort().join(" "); }
function tokenClusterId(query: string): string { return `cluster_${sha256(tokenClusterKey(query)).slice(0, 16)}`; }

function deduplicate(valid: AnalysisRow[]): { dedup: AnalysisRow[]; duplicates: AnalysisRow[] } {
  const work = valid.map(row => ({ ...row, query_norm: normalizeSelectionQuery(row.query), _completeness: NUMERIC_FIELDS.filter(field => row[field] !== null && row[field] !== undefined).length }));
  work.sort((a, b) => {
    const aQuery = String(a.query_norm); const bQuery = String(b.query_norm);
    return (aQuery < bQuery ? -1 : aQuery > bQuery ? 1 : 0) || Number(b._completeness) - Number(a._completeness) || a.original_row_id - b.original_row_id;
  });
  const masters = new Map<string, number>();
  const dedupWork: AnalysisRow[] = [];
  const duplicates: AnalysisRow[] = [];
  for (const row of work) {
    const key = String(row.query_norm);
    if (!masters.has(key)) { masters.set(key, row.original_row_id); dedupWork.push(row); }
    else duplicates.push({ ...row, isolation_type: "EXACT_DUPLICATE_REMOVED", isolation_detail: "NFKC+trim+空白合并+lower精确重复；指标不累加", kept_master_row_id: masters.get(key) });
  }
  for (const row of [...dedupWork, ...duplicates]) delete row._completeness;
  const dedup = dedupWork.map(row => ({ ...row, token_cluster_key: tokenClusterKey(String(row.query_norm)), token_cluster_id: tokenClusterId(String(row.query_norm)) }));
  dedup.sort((a, b) => a.original_row_id - b.original_row_id);
  return { dedup, duplicates };
}

const RUSSIAN_SUFFIXES = [
  "иями", "ями", "ами", "ового", "евого", "ными", "ыми", "ими", "ения", "ание", "ение", "ости", "ести", "елью", "иях", "ях",
  "ах", "ого", "его", "ому", "ему", "иям", "ям", "ием", "ьям", "ью", "ию", "ия", "ие", "ья", "ье", "ов", "ев", "ой", "ей", "ый", "ий",
  "ая", "яя", "ое", "ее", "ые", "ым", "им", "ых", "их", "ам", "ем", "ом", "ат", "ят", "ут", "ют", "ет", "ит", "ешь", "ите", "ала", "яла",
  "али", "яли", "ать", "ять", "ить", "ыть", "а", "я", "о", "е", "ы", "и", "у", "ю",
].sort((a, b) => b.length - a.length);
function stemToken(input: string): string {
  const token = foldYo(input);
  if (!/[а-я]/.test(token)) return token;
  if (token.startsWith("женщин") || token.startsWith("женск")) return "жен";
  if (/^рем(?:ень|ня|ню|нем|не|ни|ней|ням|нями|нях)$/.test(token)) return "ремен";
  if (token.startsWith("датчик")) return "датчик";
  if (token.length <= 4) return token;
  for (const suffix of RUSSIAN_SUFFIXES) if (token.endsWith(suffix) && token.length - suffix.length >= 4) return token.slice(0, -suffix.length);
  return token;
}
function literalPhraseMatches(query: unknown, phrase: string): boolean {
  const tokens = queryTokens(query); const pattern = queryTokens(phrase);
  if (!pattern.length || tokens.length < pattern.length) return false;
  for (let start = 0; start <= tokens.length - pattern.length; start++) if (pattern.every((token, index) => tokens[start + index] === token)) return true;
  return false;
}
function stemPhraseMatches(query: unknown, phrase: string): boolean {
  const tokens = queryTokens(query).filter(token => !STOPWORDS.has(token));
  const ruleTokens = queryTokens(phrase).filter(token => !STOPWORDS.has(token));
  if (!ruleTokens.length) return false;
  const stems = tokens.map(stemToken);
  for (const rawRule of ruleTokens) {
    const ruleStem = stemToken(rawRule);
    const matched = tokens.some((rawToken, index) => rawToken === rawRule || stems[index] === ruleStem || (ruleStem.length >= 4 && rawToken.startsWith(ruleStem)) || (stems[index].length >= 4 && ruleStem.startsWith(stems[index])));
    if (!matched) return false;
  }
  return true;
}
function guardMatches(query: string, config: RuntimeSelectionConfig): GovernanceRule[] {
  const matches: GovernanceRule[] = [];
  config.blacklist.forEach((phrase, index) => {
    if (literalPhraseMatches(query, phrase)) matches.push({ category: "BRAND_IP_BLACKLIST", rule_id: `blacklist.txt[${index}]`, pattern: phrase, reason: "命中本地品牌/IP/平台黑名单" });
  });
  const categories: Record<GovernanceCategory, string> = { terminatedDirections: "SHOP_TERMINATED_DIRECTION", existingPortfolioExclusions: "SHOP_EXISTING_SKU", nonPurchaseNoiseTokens: "NON_PURCHASE_NOISE", brandWatchTokens: "BRAND_IP_BLACKLIST" };
  for (const category of GOVERNANCE_CATEGORIES) for (const rule of config.governanceRules[category]) {
    const tokens = queryTokens(rule.pattern);
    if (category === "nonPurchaseNoiseTokens" && tokens.length === 1 && AMBIGUOUS_BARE_NOISE_TOKENS.has(tokens[0])) continue;
    const matched = category === "brandWatchTokens" ? literalPhraseMatches(query, rule.pattern)
      : category === "nonPurchaseNoiseTokens" ? (tokens.length > 1 ? stemPhraseMatches(query, rule.pattern) : literalPhraseMatches(query, rule.pattern))
        : stemPhraseMatches(query, rule.pattern);
    if (matched) matches.push({ ...rule, category: categories[category] });
  }
  return matches;
}
function applyGuards(dedup: AnalysisRow[], config: RuntimeSelectionConfig): { eligible: AnalysisRow[]; filtered: AnalysisRow[] } {
  const eligible: AnalysisRow[] = [];
  const filtered: AnalysisRow[] = [];
  const priority: Record<string, number> = { SHOP_TERMINATED_DIRECTION: 0, SHOP_EXISTING_SKU: 1, BRAND_IP_BLACKLIST: 2, NON_PURCHASE_NOISE: 3 };
  for (const row of dedup) {
    const matches = guardMatches(row.query, config);
    if (!matches.length) { eligible.push(row); continue; }
    matches.sort((a, b) => priority[a.category] - priority[b.category] || (a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0));
    const primary = matches[0];
    filtered.push({ ...row,
      filter_category: primary.category,
      matched_rule_id: [...new Set(matches.map(item => item.rule_id))].join("|"),
      matched_keyword_or_pattern: [...new Set(matches.map(item => item.pattern))].join("|"),
      filter_explanation: [...new Set(matches.map(item => item.reason))].join("|"),
      all_filter_categories: [...new Set(matches.map(item => item.category))].join("|"),
      governance_audit_json: JSON.stringify(matches),
    });
  }
  filtered.sort((a, b) => {
    const aCategory = String(a.filter_category); const bCategory = String(b.filter_category);
    return (aCategory < bCategory ? -1 : aCategory > bCategory ? 1 : 0) || Number(b.count) - Number(a.count) || a.original_row_id - b.original_row_id;
  });
  return { eligible, filtered };
}

export function linearQuantile(values: Array<number | null>, probability: number): number | null {
  const sorted = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (probability < 0 || probability > 1 || !Number.isFinite(probability)) throw new SelectionAnalysisError("分位数概率必须在0..1");
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position); const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export type ScaleMetadata = {
  present: number; missingOrIneligible: number; log1p: boolean;
  lowerAnchor: number | null; upperAnchor: number | null; lowerAnchorRaw: number | null; upperAnchorRaw: number | null; collapsedTo: number | null;
};
export function scaleRobust(values: Array<number | null>, quantiles: [number, number], options: { logTransform?: boolean; positiveOnly?: boolean; upperAnchorCap?: number } = {}): { scores: Array<number | null>; metadata: ScaleMetadata } {
  const logTransform = options.logTransform || false;
  const eligible = values.map(value => typeof value === "number" && Number.isFinite(value) && (!options.positiveOnly || value > 0));
  const presentValues = values.filter((_value, index) => eligible[index]) as number[];
  const metadata: ScaleMetadata = { present: presentValues.length, missingOrIneligible: values.length - presentValues.length, log1p: logTransform, lowerAnchor: null, upperAnchor: null, lowerAnchorRaw: null, upperAnchorRaw: null, collapsedTo: null };
  const scores: Array<number | null> = values.map(() => null);
  if (!presentValues.length) return { scores, metadata };
  const transformed = presentValues.map(value => logTransform ? Math.log1p(value) : value);
  const lower = linearQuantile(transformed, quantiles[0]);
  let upper = linearQuantile(transformed, quantiles[1]);
  if (lower === null || upper === null) return { scores, metadata };
  if (options.upperAnchorCap !== undefined) upper = Math.min(upper, options.upperAnchorCap);
  metadata.lowerAnchor = lower; metadata.upperAnchor = upper;
  metadata.lowerAnchorRaw = logTransform ? Math.expm1(lower) : lower;
  metadata.upperAnchorRaw = logTransform ? Math.expm1(upper) : upper;
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower) {
    eligible.forEach((yes, index) => { if (yes) scores[index] = 0.5; });
    metadata.collapsedTo = 0.5;
    return { scores, metadata };
  }
  values.forEach((value, index) => {
    if (!eligible[index] || value === null) return;
    const transformedValue = logTransform ? Math.log1p(value) : value;
    scores[index] = Math.min(1, Math.max(0, (transformedValue - lower) / (upper - lower)));
  });
  return { scores, metadata };
}

function round2(value: number): number { return Number(value.toFixed(2)); }
export function combineOpportunityScore(heat: number | null, noInt: number | null, ca: number | null, price: number | null): { score: number | null; activeWeight: number; status: string } {
  const components = { heat, no_int: noInt, ca, price };
  let activeWeight = 0; let weighted = 0;
  for (const [name, value] of Object.entries(components) as Array<[keyof typeof FIXED_WEIGHTS, number | null]>) {
    if (value === null || !Number.isFinite(value)) continue;
    activeWeight += FIXED_WEIGHTS[name]; weighted += FIXED_WEIGHTS[name] * value;
  }
  if (activeWeight + 1e-12 < MIN_ACTIVE_WEIGHT) return { score: null, activeWeight: round2(activeWeight), status: "INSUFFICIENT_METRICS" };
  return { score: round2(100 * weighted / activeWeight), activeWeight: round2(activeWeight), status: activeWeight + 1e-12 >= 1 ? "FULL_4D_RANKING_ONLY" : "PARTIAL_RENORMALIZED" };
}

function numberValue(row: AnalysisRow, field: string): number | null {
  const value = row[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function atLeast(row: AnalysisRow, field: string, threshold: number): boolean { const value = numberValue(row, field); return value !== null && value >= threshold; }
function atMost(row: AnalysisRow, field: string, threshold: number): boolean { const value = numberValue(row, field); return value !== null && value <= threshold; }
function between(row: AnalysisRow, field: string, lower: number, upper: number): boolean { return atLeast(row, field, lower) && atMost(row, field, upper); }

function addPriceObservation(row: AnalysisRow): void {
  const price = numberValue(row, "avgCaRub"); const carts = numberValue(row, "uniqQueriesWCa");
  row.avgCaRub_effective = price; row.price_obs_status = "OBSERVED";
  const noCart = carts === 0 && price === 0;
  if (noCart) { row.avgCaRub_effective = null; row.price_obs_status = "UNOBSERVED_NO_CART"; }
  if (price === null) row.price_obs_status = "MISSING_NULL";
  if (price !== null && price <= 0 && !noCart) { row.avgCaRub_effective = null; row.price_obs_status = "NON_POSITIVE_PRICE_UNOBSERVED"; }
}

function scoreAndClassify(eligible: AnalysisRow[], config: RuntimeSelectionConfig): { rows: AnalysisRow[]; scaling: Record<string, ScaleMetadata> } {
  eligible.forEach(addPriceObservation);
  const scaling: Record<string, ScaleMetadata> = {};
  const definitions = [
    ["heat", "count", "S_heat", { logTransform: true }],
    ["no_int", "usersWithoutInterectionShare", "S_no_int", { upperAnchorCap: Math.min(85, config.thresholds.no_interaction_dead_bounce_max_pct) }],
    ["ca", "ca", "S_ca", {}],
    ["price", "avgCaRub_effective", "S_price", { logTransform: true, positiveOnly: true, upperAnchorCap: Math.log1p(config.thresholds.avg_price_cross_border_safe_max_rub) }],
  ] as const;
  for (const [name, field, output, options] of definitions) {
    const scaled = scaleRobust(eligible.map(row => numberValue(row, field)), config.thresholds.robust_scale_quantiles, options);
    scaling[name] = scaled.metadata;
    eligible.forEach((row, index) => { row[output] = scaled.scores[index]; });
  }
  for (const row of eligible) {
    const combined = combineOpportunityScore(numberValue(row, "S_heat"), numberValue(row, "S_no_int"), numberValue(row, "S_ca"), numberValue(row, "S_price"));
    row.Opportunity_Score = combined.score; row.active_weight_sum = combined.activeWeight; row.score_status = combined.status;
    const t = config.thresholds;
    const blue = between(row, "count", t.count_days7_niche_min, t.count_days7_sweet_spot_max)
      && between(row, "usersWithoutInterectionShare", t.no_interaction_gap_min_pct, t.no_interaction_dead_bounce_max_pct)
      && (atMost(row, "uniqSellers", t.uniq_sellers_low_density_max) || atLeast(row, "zrShare", t.zr_share_signal_min_pct))
      && atLeast(row, "ord", t.ord_commercial_proof_min_buyers)
      && between(row, "avgCaRub_effective", t.avg_price_fbs_viable_floor_rub, t.avg_price_cross_border_safe_max_rub);
    const highConversion = atLeast(row, "count", t.count_days7_niche_min) && atLeast(row, "ca", t.ca_high_demand_min_pct)
      && atLeast(row, "searchUsersToOrdUsers", t.ord_conv_rigid_min_pct) && atLeast(row, "ord", t.ord_rigid_demand_min_buyers)
      && between(row, "avgCaRub_effective", t.avg_price_high_conversion_floor_rub, t.avg_price_cross_border_safe_max_rub);
    const highTicket = between(row, "count", t.count_days7_valid_floor, t.count_days7_sweet_spot_max)
      && between(row, "avgCaRub_effective", t.avg_price_high_ticket_min_rub, t.avg_price_cross_border_safe_max_rub)
      && atLeast(row, "ord", 100) && atLeast(row, "ca", t.ca_high_ticket_min_pct);
    const hits = QUADRANT_PRIORITY.filter((_label, index) => [blue, highConversion, highTicket][index]);
    const primary: string = hits[0] || REGULAR_QUADRANT;
    const risks: string[] = []; const quality: string[] = [];
    if (numberValue(row, "ord") === 0 && atLeast(row, "usersWithoutInterectionShare", t.no_interaction_dead_bounce_max_pct + 1e-9) && Number(row.usersWithoutInterectionShare) > t.no_interaction_dead_bounce_max_pct) {
      risks.push("ZERO_ORDER_DEAD_BOUNCE"); quality.push("WARN_ZERO_ORDER_HIGH_BOUNCE");
    }
    if (atLeast(row, "count", t.count_days7_broad_head_warn + 1e-9) && Number(row.count) > t.count_days7_broad_head_warn) {
      risks.push("BROAD_MEGA_TERM"); quality.push("WARN_BROAD_HEAD_TERM");
      if (atLeast(row, "uniqSellers", 35)) risks.push("BROAD_RED_OCEAN_HEAD_TERM");
    }
    const price = numberValue(row, "avgCaRub_effective");
    if (price !== null) {
      if (price > t.avg_price_extreme_outlier_rub) { risks.push("EXTREME_PRICE_OUTLIER"); quality.push("WARN_EXTREME_PRICE_OUTLIER"); }
      else if (price > t.avg_price_cross_border_safe_max_rub) { risks.push("PRICE_ABOVE_SAFE_BAND"); quality.push("WARN_PRICE_ABOVE_SAFE_BAND"); }
      else if (0 < price && price < t.avg_price_fbs_viable_floor_rub) { risks.push("LOW_TICKET_FBS_MARGIN_HIGH_RISK"); quality.push("LOW_TICKET_FBS_MARGIN_HIGH_RISK"); }
    }
    if (row.price_obs_status === "UNOBSERVED_NO_CART") quality.push("PARTIAL_PRICE_UNOBSERVED");
    if (!quality.length) quality.push(row.score_status === "FULL_4D_RANKING_ONLY" ? "NUMERIC_FULL_4D_ONLY" : "PARTIAL_METRICS");
    let subPool: string;
    if (primary !== REGULAR_QUADRANT) subPool = "SPECIAL_QUADRANT_PENDING_REVIEW";
    else if (risks.includes("BROAD_MEGA_TERM")) subPool = "BROAD_MEGA_TERM";
    else if (risks.includes("EXTREME_PRICE_OUTLIER") || risks.includes("PRICE_ABOVE_SAFE_BAND")) subPool = "EXTREME_HIGH_PRICE_REVIEW";
    else if (risks.includes("LOW_TICKET_FBS_MARGIN_HIGH_RISK")) subPool = "LOW_PRICE_FBS_SQUEEZE";
    else if (row.score_status === "INSUFFICIENT_METRICS") subPool = "INSUFFICIENT_METRICS";
    else subPool = "STANDARD_OBSERVATION";
    row.all_matched_quadrants = hits.length ? hits.join("|") : REGULAR_QUADRANT;
    row.primary_quadrant = primary;
    row.quadrant_hypothesis_note = "CANDIDATE_HYPOTHESIS_ONLY_待核非授权";
    row.risk_flags = risks.join("|"); row.data_quality_status = [...new Set(quality)].join("|"); row.sub_pool_reason = subPool;
  }
  return { rows: eligible, scaling };
}

function parseReviewFlags(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const items = typeof value === "string" ? [value] : value;
  if (!Array.isArray(items)) throw new SelectionAnalysisError("review_flags必须是数组或|分隔字符串", 500, "SELECTION_CONFIG_INVALID");
  const flags: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") throw new SelectionAnalysisError("review_flags数组元素必须是字符串", 500, "SELECTION_CONFIG_INVALID");
    for (const part of item.split("|")) {
      const flag = part.trim().toUpperCase();
      if (flag && !flags.includes(flag)) flags.push(flag);
    }
  }
  return flags;
}
function quotePlus(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+").replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}
function draftText(value: unknown, fallback: string): string {
  const text = value === null || value === undefined ? "" : String(value).trim();
  const result = text || fallback;
  return result.startsWith("[待审草稿]") ? result : `[待审草稿] ${result}`;
}
function enrich(row: AnalysisRow, config: RuntimeSelectionConfig, clusterSizes: Map<string, number>): void {
  const encoded = quotePlus(row.query.trim());
  const override = config.reviewOverrides[normalizeSelectionQuery(row.query)] || {};
  row.ozon_search_url = `https://www.ozon.ru/search/?text=${encoded}&from_global=true`;
  row.yandex_search_url = `https://yandex.ru/search/?text=${encoded}`;
  row.wordstat_url = `https://wordstat.yandex.ru/?region=225&view=table&words=${encoded}`;
  row.cn_gloss_draft = draftText(override.cn_gloss, "待Kimi复核中文释义");
  row.form_hypothesis_draft = draftText(override.form_hypothesis || override.form, "待Kimi复核产品形态；不推断材质、规格、OE、重量或合规");
  row.translation_override_status = config.reviewOverrides[normalizeSelectionQuery(row.query)] ? "APPLIED_PENDING_KIMI_REVIEW" : "NOT_PROVIDED";
  row.manual_review_flags = parseReviewFlags(override.review_flags).join("|");
  row.mandatory_pending_actions = MANDATORY_PENDING_ACTIONS;
  row.ws_status = "NOT_REQUESTED"; row.ws_count = null; row.ws_sourceAsOf = null; row.ws_periodWindow = null; row.ws_receiptHash = null; row.ws_sourceAsOf_and_window = null;
  row.evidence_status = "SELLER_7D_NATIVE_ONLY";
  const price = numberValue(row, "avgCaRub_effective");
  row.fbs_price_band_flag = price === null || price <= 0 ? "PRICE_UNOBSERVED" : price < config.thresholds.avg_price_fbs_viable_floor_rub ? "LOW_TICKET_FBS_MARGIN_HIGH_RISK" : price <= config.thresholds.avg_price_cross_border_safe_max_rub ? "FBS_RFBS_PRICE_BAND_PRECHECK_ONLY" : "ABOVE_CROSS_BORDER_SAFE_BAND";
  row.max_total_cost_rub_10pct = null; row.max_total_cost_rub_15pct = null; row.max_cny_budget_est_hint = null;
  row.economics_gate_status = "PENDING_REAL_COSTS_NO_NUMERIC_CAP"; row.economics_pending_inputs = PENDING_ECONOMICS_INPUTS; row.content_gate_status = "PENDING_8_IMAGES_AND_2_VIDEOS";
  row.cluster_size_in_batch = clusterSizes.get(String(row.token_cluster_id)) || 0;
}
function applyTop30(row: AnalysisRow, config: RuntimeSelectionConfig): void {
  const t = config.thresholds;
  const price = numberValue(row, "avgCaRub_effective"); const score = numberValue(row, "Opportunity_Score");
  const priceOk = price !== null && t.avg_price_fbs_viable_floor_rub <= price && price <= t.avg_price_cross_border_safe_max_rub;
  const scoreOk = score !== null && atLeast(row, "active_weight_sum", MIN_ACTIVE_WEIGHT);
  const special = (QUADRANT_PRIORITY as readonly string[]).includes(String(row.primary_quadrant));
  const riskFree = !row.risk_flags;
  const economicsOk = row.economics_gate_status === "PENDING_REAL_COSTS_NO_NUMERIC_CAP";
  const flags = String(row.manual_review_flags || "").split("|").filter(Boolean);
  const manualBlocked = flags.some(flag => (MANUAL_REVIEW_TOP30_BLOCKERS as readonly string[]).includes(flag));
  const commercialOk = atLeast(row, "ca", t.ca_viable_floor_pct) && atLeast(row, "searchUsersToOrdUsers", t.top30_min_search_to_ord_pct);
  const eligible = special && scoreOk && riskFree && priceOk && economicsOk && commercialOk && !manualBlocked;
  row.top30_eligible = eligible;
  row.top30_exclusion_reason = manualBlocked ? "MANUAL_IDENTITY_REVIEW" : eligible ? "ELIGIBLE_PENDING_REVIEW" : !special ? "REGULAR_QUADRANT" : !scoreOk ? "SCORE_INSUFFICIENT" : !priceOk || !riskFree ? "PRICE_OR_RISK" : !economicsOk ? "ECONOMICS_GATE" : numberValue(row, "ca") === null || numberValue(row, "searchUsersToOrdUsers") === null ? "MISSING_COMMERCIAL_INTENT" : "LOW_COMMERCIAL_INTENT";
}

function quantileSnapshot(rows: AnalysisRow[]): Record<string, Record<string, number | null>> {
  const result: Record<string, Record<string, number | null>> = {};
  for (const field of NUMERIC_FIELDS) {
    const all = rows.map(row => numberValue(row, field));
    const present = all.filter((value): value is number => value !== null).sort((a, b) => a - b);
    result[field] = {
      present: present.length, missing: rows.length - present.length,
      min: present[0] ?? null, p05: linearQuantile(present, 0.05), p50: linearQuantile(present, 0.50), p90: linearQuantile(present, 0.90), p95: linearQuantile(present, 0.95), max: present[present.length - 1] ?? null,
    };
  }
  return result;
}

export function analyzeSelectionRows(rows: Array<Record<string, unknown>>, config: RuntimeSelectionConfig, run: SelectionRunMetadata): SelectionAnalysis {
  if ((run.nativePeriod || "days_7") !== "days_7") throw new SelectionAnalysisError("仅支持days_7成功批次", 400, "SELECTION_UNSUPPORTED_PERIOD");
  const { valid, invalid } = cleanRows(rows);
  const { dedup, duplicates } = deduplicate(valid);
  const quantiles = quantileSnapshot(dedup);
  const { eligible, filtered } = applyGuards(dedup, config);
  const { rows: detail, scaling } = scoreAndClassify(eligible, config);
  const clusterSizes = new Map<string, number>();
  for (const row of detail) {
    const key = String(row.token_cluster_id); clusterSizes.set(key, (clusterSizes.get(key) || 0) + 1);
  }
  detail.forEach(row => { enrich(row, config, clusterSizes); applyTop30(row, config); });
  const top30 = detail.filter(row => row.top30_eligible === true).sort((a, b) => Number(b.Opportunity_Score) - Number(a.Opportunity_Score) || a.original_row_id - b.original_row_id).slice(0, 30)
    .map((row, index) => ({ ...row, rank_in_batch: index + 1 }));
  const quarantine = [...invalid, ...duplicates];
  const categoryCount = (category: string) => filtered.filter(row => row.filter_category === category).length;
  const conservedRows = detail.length + filtered.length + quarantine.length;
  if (conservedRows !== rows.length) throw new SelectionAnalysisError(`过滤漏斗行数不守恒: 原始${rows.length}, 输出合计${conservedRows}`, 500, "SELECTION_CONSERVATION_FAILED");
  const filterFunnel = {
    rawRows: rows.length, invalidRows: invalid.length, exactDuplicatesRemoved: duplicates.length, quarantineAndDuplicates: quarantine.length,
    brandAndIpFiltered: categoryCount("BRAND_IP_BLACKLIST"), existingPortfolioFiltered: categoryCount("SHOP_EXISTING_SKU"),
    terminatedDirectionsFiltered: categoryCount("SHOP_TERMINATED_DIRECTION"), nonPurchaseNoiseFiltered: categoryCount("NON_PURCHASE_NOISE"),
    governanceFiltered: filtered.length, deduplicatedRows: dedup.length, eligibleRows: detail.length, top30Actual: top30.length,
    markdownTop10Actual: Math.min(10, top30.length), conservedRows,
  };
  const quadrantCounts = Object.fromEntries([...QUADRANT_PRIORITY, REGULAR_QUADRANT].map(label => [label, detail.filter(row => row.primary_quadrant === label).length]));
  const allMatchedQuadrantCounts = Object.fromEntries([...QUADRANT_PRIORITY, REGULAR_QUADRANT].map(label => [label, detail.filter(row => String(row.all_matched_quadrants).split("|").includes(label)).length]));
  const safeRun = {
    runId: run.runId, anchorAt: run.anchorAt, nativePeriod: "days_7", sourceType: run.sourceType || "native_7d",
    pageCount: run.pageCount ?? null, expectedPages: run.expectedPages ?? null, rowCount: run.rowCount ?? rows.length, contentSha256: run.hash,
  };
  const manifest: Record<string, unknown> = {
    toolVersion: "1.0.0-python-reference", algorithmVersion: SELECTION_ALGORITHM_VERSION, runtime: "NODE_TYPESCRIPT",
    analysisMode: "DB_READONLY", profile: SELECTION_PROFILE, runId: run.runId, anchorAt: run.anchorAt, nativePeriod: "days_7",
    nativePeriodDescription: "Ozon Seller原生相对7天市场查询口径；日历起止与时区未知；非月搜索量、非本店SKU漏斗、count不可跨词累加",
    run: safeRun, pages: run.pages || [], hash: run.hash,
    metricSemantics: {
      itemsViews: "展示商品数量（shown_items_count），不是商品浏览量或平均浏览商品数",
      ord: "下单独立买家，不是订单数或商品件数",
      gmv: "按查询归因的订购金额，不是结算收入",
      avgCaRub: "市场平均价格RUB，不是CPC或本店可实现成交价",
    },
    dataQualitySemantics: { NUMERIC_FULL_4D_ONLY: "仅表示四维评分输入数值完整，不代表身份、合规或商业PASS" },
    filterFunnel, quadrantCounts, allMatchedQuadrantCounts,
    quantileScopes: {
      quantiles: "清洗并精确去重后、治理过滤前的完整有效唯一词分布，用于对照原始真实分布基准",
      eligibleQuantiles: "治理过滤后进入四象限明细的候选分布，不用于替代完整批次分布",
    },
    quantiles, eligibleQuantiles: quantileSnapshot(detail),
    parameters: {
      fixedWeights: FIXED_WEIGHTS, minimumActiveWeight: MIN_ACTIVE_WEIGHT, thresholds: config.thresholds,
      quadrantPriority: [...QUADRANT_PRIORITY, REGULAR_QUADRANT],
      top30CommercialIntentGate: { caMinPct: config.thresholds.ca_viable_floor_pct, searchUsersToOrdUsersMinPct: config.thresholds.top30_min_search_to_ord_pct, missingPolicy: "EXCLUDE_WITHOUT_ZERO_IMPUTATION" },
      top30Rule: `仅专项象限+有效评分+${config.thresholds.avg_price_fbs_viable_floor_rub}..${config.thresholds.avg_price_cross_border_safe_max_rub}RUB价格带+无风险+ca>=${config.thresholds.ca_viable_floor_pct}%+searchUsersToOrdUsers>=${config.thresholds.top30_min_search_to_ord_pct}%（缺失不补0）+无AMBIGUOUS_IDENTITY/BRAND_REVIEW_REQUIRED人工复核阻断；不足不补`,
    },
    scaling,
    configuration: { sha256: config.configSha256, files: config.configFiles },
    configHash: config.configSha256,
    governance: {
      centralRuleCategoriesReused: GOVERNANCE_CATEGORIES,
      auditSheet: "品牌词过滤记录（同时承载品牌、既有、终止与非购买噪音审计）",
      nonPurchaseNoiseAdapter: { ambiguousBareTokensNotAutoFiltered: ["фото", "видео", "ремонт"], singleTokenMode: "LITERAL_WHOLE_WORD", multiTokenMode: "STEM_COMBINATION", note: "歧义裸词不自动隔离；中央配置不变" },
    },
    wordstat: { enabled: false, status: "NOT_REQUESTED", sourceAsOf: null, periodWindow: null, receiptSha256: null, receiptFileSha256: null, error: null, counts: { VALID: 0, MISSING: 0, UNCERTAIN: 0, NOT_REQUESTED: detail.length } },
    translationOverrides: {
      reviewStatus: "ALL_TEXT_REMAINS_待审草稿_FOR_KIMI_REVIEW", manualReviewFlagField: "manual_review_flags", supportedReviewFlagInput: "数组或|分隔字符串",
      top30BlockingReviewFlags: MANUAL_REVIEW_TOP30_BLOCKERS, blockingReason: "MANUAL_IDENTITY_REVIEW",
    },
    economics: {
      model: "国内跨境FBS/rFBS真实成本待核", testableNetMarginMinimum: 0.10, preferredNetMarginMinimum: 0.15,
      numericCostCapsCalculated: false, reason: "1688实价/国内运费/包装/实测克重尺寸/实际仓线/佣金/退货/支付/CPS未齐，不用占位费率输出伪精确上限",
      pendingInputs: PENDING_ECONOMICS_INPUTS, contentRequirement: "完整8图+双视频+独立复核",
    },
    mandatoryPendingActions: MANDATORY_PENDING_ACTIONS,
    governanceBoundaries: GOVERNANCE_BOUNDARIES,
    note: "Top30是查询行，不是独立方向或合格SKU；相关词必须合并调研，非立项或上架授权",
  };
  return { manifest, top30, detail, filtered, quarantine };
}

export function toSelectionResponse(analysis: SelectionAnalysis): Record<string, unknown> {
  const manifest = Object.fromEntries(Object.entries(analysis.manifest).filter(([key]) => key !== "pages"));
  return { ...manifest, top30: analysis.top30 };
}

function parseJsonObject(value: unknown, description: string): Record<string, unknown> {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); }
    catch { throw new SelectionAnalysisError(`${description}不是合法JSON`, 409, "SELECTION_SNAPSHOT_INVALID"); }
  }
  if (!isRecord(parsed)) throw new SelectionAnalysisError(`${description}必须是对象`, 409, "SELECTION_SNAPSHOT_INVALID");
  return parsed;
}

export async function analyzeSearchSelection(db: DbAdapter, options: { runId?: string; config?: SelectionConfigOptions } = {}): Promise<SelectionAnalysis> {
  const runRows = options.runId
    ? await db.all<Record<string, unknown>>("SELECT * FROM ozon_search_collection_runs WHERE run_id=? AND status='succeeded' AND native_period='days_7'", [options.runId])
    : await db.all<Record<string, unknown>>("SELECT * FROM ozon_search_collection_runs WHERE status='succeeded' AND native_period='days_7' ORDER BY anchor_at DESC LIMIT 1");
  const run = runRows[0];
  if (!run) throw new SelectionAnalysisError(options.runId ? `指定days_7成功批次不存在: ${options.runId}` : "暂无可用的days_7成功批次", 404, "SELECTION_RUN_NOT_FOUND");
  const rowCount = Number(run.row_count);
  if (!Number.isInteger(rowCount) || rowCount < 0) throw new SelectionAnalysisError("成功批次row_count无效", 409, "SELECTION_BATCH_INCOMPLETE");
  if (typeof run.content_sha256 !== "string" || !run.content_sha256) throw new SelectionAnalysisError("成功批次缺少内容SHA-256", 409, "SELECTION_BATCH_INCOMPLETE");
  const snapshots = await db.all<Record<string, unknown>>(
    "SELECT query_text,page_number,row_number,metrics_json FROM ozon_search_query_snapshots WHERE run_id=? ORDER BY search_popularity DESC NULLS LAST, page_number ASC, row_number ASC",
    [run.run_id],
  );
  if (snapshots.length !== rowCount) throw new SelectionAnalysisError(`批次快照不完整：run.row_count=${rowCount}，实际读取=${snapshots.length}；拒绝分析部分批次`, 409, "SELECTION_BATCH_INCOMPLETE");
  const rows = snapshots.map(snapshot => {
    const metrics = parseJsonObject(snapshot.metrics_json, "快照metrics_json");
    if (metrics.query !== undefined && metrics.query !== snapshot.query_text) throw new SelectionAnalysisError("快照query_text与metrics_json.query不一致", 409, "SELECTION_SNAPSHOT_INVALID");
    return { ...metrics, query: snapshot.query_text };
  });
  let pages: unknown[] = [];
  if (run.pages_json) {
    try {
      const parsed = typeof run.pages_json === "string" ? JSON.parse(run.pages_json) : run.pages_json;
      if (!Array.isArray(parsed)) throw new Error("not array");
      pages = parsed;
    } catch { throw new SelectionAnalysisError("批次pages_json无效", 409, "SELECTION_BATCH_INCOMPLETE"); }
  }
  const config = loadSelectionConfig(options.config);
  return analyzeSelectionRows(rows, config, {
    runId: String(run.run_id), anchorAt: run.anchor_at === null || run.anchor_at === undefined ? null : String(run.anchor_at), nativePeriod: "days_7",
    pages, hash: run.content_sha256, pageCount: run.page_count === null || run.page_count === undefined ? null : Number(run.page_count),
    expectedPages: run.expected_pages === null || run.expected_pages === undefined ? null : Number(run.expected_pages), rowCount,
    sourceType: run.source_type ? String(run.source_type) : "native_7d",
  });
}
