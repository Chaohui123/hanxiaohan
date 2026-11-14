import { useState } from "react";
import { Alert, Button, Card, Input, Segmented, Select, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import { DownloadOutlined, LineChartOutlined, ReloadOutlined, RocketOutlined } from "@ant-design/icons";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as ChartTooltip, ResponsiveContainer } from "recharts";
import dayjs from "dayjs";
import PageContainer from "../components/PageContainer";
import QueryState from "../components/QueryState";
import SelectionCandidates from "./SelectionCandidates";
import {
  searchAnalyticsApi, useSearchQueries, useSearchRuns, useSearchTrend,
  type DerivedQueryRow, type SearchQueryRow,
} from "../api/search-analytics-api";

const metrics = [
  ["count", "搜索热度", "count"], ["dynamic28", "动态28天", "percent"], ["dynamic7", "动态7天", "percent"],
  ["uniqQueriesWCa", "加入购物车", "count"], ["ca", "加购转化率", "percent"],
  ["ord", "独立买家", "count"], ["searchUsersToOrdUsers", "订单转化率", "percent"],
  ["gmv", "订购金额", "rub"], ["avgCaRub", "平均价格", "rub"], ["itemsViews", "展示商品数", "count"],
  ["uniqSellers", "竞争卖家", "count"], ["usersWithoutInterectionCount", "无操作查询", "count"],
  ["usersWithoutInterectionShare", "无操作份额", "percent"], ["softQueryCount", "类似结果查询", "count"],
  ["softQueryShare", "类似结果份额", "percent"], ["zrCount", "无结果查询", "count"], ["zrShare", "无结果份额", "percent"],
] as const;

type Row = SearchQueryRow | DerivedQueryRow;

function formatValue(value: unknown, unit: string): string {
  if (value === null || value === undefined) return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `${number.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}${unit === "percent" ? "%" : unit === "rub" ? " ₽" : ""}`;
}

function cell(row: Row, field: string, window: string) {
  if (window === "28") return (row as DerivedQueryRow).metrics[field];
  const native = row as SearchQueryRow;
  if (field === "dynamic28") return native.dynamic28;
  if (field === "dynamic7") return native.dynamic7;
  return native.rawMetrics[field];
}

export default function SearchAnalytics() {
  const [window, setWindow] = useState<"7" | "28">("7");
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sort, setSort] = useState("count");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [selectedQuery, setSelectedQuery] = useState("");
  const [trendMetric, setTrendMetric] = useState("count");
  const [tab, setTab] = useState("queries");
  const [exporting, setExporting] = useState(false);
  const params = { window, query, page, pageSize, sort, direction };
  const result = useSearchQueries(params);
  const runs = useSearchRuns();
  const trend = useSearchTrend(selectedQuery);

  const download = async (format: "csv" | "xlsx") => {
    setExporting(true);
    try {
      const blob = await searchAnalyticsApi.exportFile(params, format);
      if (!blob.size) throw new Error("导出文件为空");
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `ozon-search-${window}d-${dayjs().format("YYYYMMDD-HHmmss")}.${format}`;
      anchor.click();
      URL.revokeObjectURL(url);
      message.success("导出已生成，文件内含数据来源与口径说明");
    } catch (error) { message.error((error as Error).message); }
    finally { setExporting(false); }
  };

  const columns = [
    {
      title: "搜索查询", dataIndex: "query", key: "query", fixed: "left" as const, width: 240,
      sorter: true, sortOrder: sort === "query" ? ((direction === "asc" ? "ascend" : "descend") as "ascend" | "descend") : null,
      render: (value: string, row: Row) => (
        <Space size={4}>
          <Typography.Text ellipsis={{ tooltip: value }} style={{ maxWidth: 165 }}>{value}</Typography.Text>
          <Tooltip title="查看该词的原生7天历史趋势">
            <Button type="text" size="small" aria-label={`查看 ${value} 的历史趋势`} icon={<LineChartOutlined />} onClick={() => { setSelectedQuery(value); setTab("trend"); }} />
          </Tooltip>
          {window === "28" && (row as DerivedQueryRow).weekly.some(week => week.metrics === null) && <Tag>部分周未出现</Tag>}
        </Space>
      ),
    },
    ...metrics.map(([field, title, unit]) => ({
      title, key: field, width: 132, sorter: field !== "dynamic28" && field !== "dynamic7",
      sortOrder: sort === field ? ((direction === "asc" ? "ascend" : "descend") as "ascend" | "descend") : null,
      render: (_: unknown, row: Row) => {
        const value = cell(row, field, window);
        const derived = (window === "28" ? value : null) as { value: unknown; reason: string | null } | null;
        const display = formatValue(derived ? derived.value : value, unit);
        if (derived?.reason) return <Tooltip title={`${derived.reason}；分周原值保留，可在导出中复核`}>{display}</Tooltip>;
        if ((field === "dynamic28" || field === "dynamic7") && (value === null || value === undefined)) return <Tooltip title="未返回的会员字段，不是0">—</Tooltip>;
        return display;
      },
    })),
  ];

  const data = result.data?.window === Number(window) ? result.data : undefined;
  const lastAttempt = runs.data?.lastAttempt;
  const lastSuccess = runs.data?.lastSuccess;
  const trendPoints = trend.data?.items.map(item => ({ ...item, value: item.metrics[trendMetric], time: dayjs(item.collectedAt).format("MM-DD HH:mm") })) || [];

  return (
    <PageContainer
      title="搜索查询与选品"
      subTitle="Seller原生市场查询与待核选品候选；不等于本店SKU订单漏斗，不构成上架授权"
      updatedAt={result.dataUpdatedAt}
      extra={
        <Space wrap>
          <Tag color="orange">本机Chrome采集</Tag>
          <Button icon={<ReloadOutlined />} onClick={() => { result.refetch(); runs.refetch(); }}>刷新</Button>
          <Button icon={<DownloadOutlined />} loading={exporting} onClick={() => download("csv")}>CSV</Button>
          <Button type="primary" icon={<DownloadOutlined />} loading={exporting} onClick={() => download("xlsx")}>XLSX</Button>
        </Space>
      }
    >
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        {runs.data?.stale && <Alert type="warning" showIcon message="最近成功数据已超过30小时或尚未成功采集" description="旧数据继续保留，但不会伪装成今日成功。请检查本机Chrome登录态和定时任务。" />}
        {lastAttempt?.status === "failed" && <Alert type="error" showIcon message={`最近一次采集失败：${lastAttempt.errorCode || "未知错误"}`} description={`${lastAttempt.error || "请检查采集日志"}；最近成功运行：${lastSuccess?.runId || "暂无"}`} />}
        <Alert type="info" showIcon message="原生7天与自建28天分开" description="每日滚动7天重叠6天，不能直接相加。28天只使用四个不重叠的周窗口；独立买家不去重相加，未确认口径的指标保留分周原值。接口未返回自然日边界和时区，因此不伪称官方自然日28天。" />
        {tab !== "selection" && <Space wrap>
          <Segmented value={window} onChange={value => { setWindow(value as "7" | "28"); setPage(1); }} options={[{ value: "7", label: "原生7天" }, { value: "28", label: "自建28天" }]} />
          <Input.Search value={input} onChange={event => setInput(event.target.value)} onSearch={value => { setQuery(value.trim()); setPage(1); }} placeholder="输入俄语查询词，按原文检索" allowClear style={{ width: 320 }} />
          <Button onClick={() => setTab(tab === "trend" ? "queries" : "trend")} icon={<LineChartOutlined />}>{tab === "trend" ? "返回查询表" : "历史趋势"}</Button>
          <Button type="primary" onClick={() => setTab("selection")} icon={<RocketOutlined />}>选品候选</Button>
        </Space>}
        {tab === "selection" ? <SelectionCandidates onBack={() => setTab("queries")} /> : tab === "trend" ? (
          <Card title={selectedQuery ? `历史趋势：${selectedQuery}` : "历史趋势"} extra={selectedQuery && <Select value={trendMetric} onChange={setTrendMetric} style={{ width: 180 }} options={metrics.filter(([field]) => !["dynamic28", "dynamic7"].includes(field)).map(([field, label]) => ({ value: field, label }))} />}>
            {!selectedQuery ? <Typography.Text type="secondary">点击查询表中的趋势按钮，选择一个搜索词。</Typography.Text> : (
              <QueryState query={trend} emptyText="该词在已有快照中没有数据">
                {() => <>
                  <Alert type="info" message={trend.data?.note} style={{ marginBottom: 16 }} />
                  <ResponsiveContainer width="100%" height={330}>
                    <LineChart data={trendPoints}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="time" /><YAxis />
                      <ChartTooltip formatter={(value) => formatValue(value, metrics.find(([field]) => field === trendMetric)?.[2] || "count")} labelFormatter={(_, payload) => payload[0]?.payload?.collectedAt || ""} />
                      <Line type="monotone" dataKey="value" stroke="#1677ff" strokeWidth={2} dot connectNulls={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </>}
              </QueryState>
            )}
          </Card>
        ) : (
          <QueryState query={result} emptyText="尚未采集到搜索查询数据">
            {() => <>
              {window === "7" && data?.run && <Typography.Text type="secondary">运行 {data.run.runId} · {data.run.nativePeriod.label || "7天"} · {data.run.pageCount}/{data.run.expectedPages}页 · 服务端锚点 {data.run.anchorAt || "未返回"}</Typography.Text>}
              {window === "28" && <Alert type={data?.coverageStatus === "complete" ? "success" : "warning"} showIcon message={data?.coverageStatus === "complete" ? "已形成四个原生7天窗口的自建视图" : `28天历史仍在积累：当前可覆盖约${data?.coverageDays || 0}/28天`} description={`${data?.reason || data?.windowBasis || "等待连续快照"} 来源运行：${data?.sourceRunIds?.join("、") || "暂无"}`} />}
              <Table<Row>
                rowKey="query"
                columns={columns}
                dataSource={data?.items || []}
                scroll={{ x: 2650 }}
                size="small"
                onChange={(pagination, _filters, sorter) => {
                  setPage(pagination.current || 1);
                  setPageSize(pagination.pageSize || 50);
                  if (!Array.isArray(sorter) && sorter.field && sorter.order) {
                    setSort(String(sorter.field)); setDirection(sorter.order === "ascend" ? "asc" : "desc");
                  } else { setSort("count"); setDirection("desc"); }
                }}
                pagination={{ current: page, pageSize, total: data?.total || 0, showSizeChanger: true, pageSizeOptions: [20, 50, 100, 200], showTotal: total => `共 ${total.toLocaleString()} 个观测查询` }}
                locale={{ emptyText: window === "28" ? "尚无满足条件的四个连续原生周窗口，不生成虚假28天数据" : "当前筛选没有匹配查询" }}
              />
            </>}
          </QueryState>
        )}
        {lastSuccess && <Typography.Text type="secondary">最近成功：{lastSuccess.runId}，{lastSuccess.rowCount.toLocaleString()}行，SHA-256 {lastSuccess.contentSha256 || "—"}</Typography.Text>}
      </Space>
    </PageContainer>
  );
}
