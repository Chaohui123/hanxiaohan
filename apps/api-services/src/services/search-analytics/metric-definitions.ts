export const SEARCH_METRIC_DEFINITION_VERSION = "native-search-v2-2026-11-09";

export type MetricDefinition = {
  field: string;
  column: string;
  label: string;
  unit: "count" | "rub" | "percent" | "json";
  aggregation: "sum" | "ratio" | "latest" | "not_computable";
  reason?: string;
};

export const SEARCH_METRICS: MetricDefinition[] = [
  { field: "count", column: "search_popularity", label: "搜索查询热度", unit: "count", aggregation: "latest", reason: "后台名称是热度，尚不能当作可加搜索事件次数" },
  { field: "dynamic28", column: "dynamic_28_pct", label: "动态28天", unit: "percent", aggregation: "not_computable", reason: "missing_required_membership" },
  { field: "dynamic7", column: "dynamic_7_pct", label: "动态7天", unit: "percent", aggregation: "not_computable", reason: "membership_field_not_returned" },
  { field: "uniqQueriesWCa", column: "cart_additions", label: "加入购物车", unit: "count", aggregation: "latest", reason: "先保留原生周值，等待官方跨周口径确认" },
  { field: "ca", column: "cart_conversion_pct", label: "加购转化率", unit: "percent", aggregation: "not_computable", reason: "不从四舍五入的比率反推分子分母" },
  { field: "ord", column: "unique_buyers", label: "下单独立买家", unit: "count", aggregation: "not_computable", reason: "无法跨周去重，周值之和不是28天独立买家" },
  { field: "searchUsersToOrdUsers", column: "order_conversion_pct", label: "订单转化率", unit: "percent", aggregation: "not_computable", reason: "分子分母及跨周去重口径未确认" },
  { field: "gmv", column: "ordered_revenue_rub", label: "按查询归因的订购金额", unit: "rub", aggregation: "latest", reason: "归因、取消与退款口径未确认，不跨周求和" },
  { field: "avgCaRub", column: "average_price_rub", label: "平均价格", unit: "rub", aggregation: "latest", reason: "不平均四周均价，权重未确认" },
  { field: "itemsViews", column: "shown_items_count", label: "展示商品数量", unit: "count", aggregation: "latest" },
  { field: "uniqSellers", column: "competitor_sellers_count", label: "竞争卖家数量", unit: "count", aggregation: "latest" },
  { field: "usersWithoutInterectionCount", column: "no_action_queries", label: "无操作搜索查询", unit: "count", aggregation: "latest", reason: "保留原始拼写对应的字段，跨周口径未确认" },
  { field: "usersWithoutInterectionShare", column: "no_action_share_pct", label: "无操作查询份额", unit: "percent", aggregation: "not_computable", reason: "未知分母，不平均份额" },
  { field: "softQueryCount", column: "similar_queries", label: "具有类似结果的查询", unit: "count", aggregation: "latest", reason: "跨周口径未确认" },
  { field: "softQueryShare", column: "similar_share_pct", label: "类似结果查询份额", unit: "percent", aggregation: "not_computable", reason: "未知分母，不平均份额" },
  { field: "zrCount", column: "no_result_queries", label: "无结果搜索查询", unit: "count", aggregation: "latest", reason: "跨周口径未确认" },
  { field: "zrShare", column: "no_result_share_pct", label: "无结果查询份额", unit: "percent", aggregation: "not_computable", reason: "未知分母，不平均份额" },
  { field: "trendForYear", column: "seasonality_json", label: "年度季节趋势原始序列", unit: "json", aggregation: "not_computable", reason: "当前为空，28天本身不能证明季节性" },
  { field: "avgCountItems", column: "", label: "接口附加原始字段", unit: "count", aggregation: "not_computable", reason: "当前页面未展示该字段，不作语义猜测；仅保留于原始metrics" },
];

export const SEARCH_SNAPSHOT_COLUMNS = [
  "snapshot_id", "run_id", "company_id", "query_text", "normalized_query", "page_number", "row_number", "collected_at",
  ...SEARCH_METRICS.filter(metric => metric.column && !metric.column.endsWith("_json")).map(metric => metric.column),
  "seasonality_json", "metrics_json", "raw_row_sha256",
] as const;

export function getMetricDefinition(field: string): MetricDefinition | undefined {
  return SEARCH_METRICS.find(metric => metric.field === field);
}
