import { useState } from "react";
import { Alert, Button, Card, Space, Statistic, Table, Tag, Tooltip, Typography, message } from "antd";
import { ArrowLeftOutlined, DownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import QueryState from "../components/QueryState";
import { searchAnalyticsApi, useSelectionCandidates, type SelectionCandidate } from "../api/search-analytics-api";

function number(value: number | null, suffix = ""): string {
  return value === null ? "N/A" : `${value.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}${suffix}`;
}

export default function SelectionCandidates({ onBack }: { onBack: () => void }) {
  const query = useSelectionCandidates(true);
  const [exporting, setExporting] = useState(false);

  const download = async (runId: string) => {
    setExporting(true);
    try {
      const blob = await searchAnalyticsApi.selectionExport(runId);
      if (!blob.size) throw new Error("导出文件为空");
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `ozon-selection-${runId}.xlsx`;
      anchor.click();
      URL.revokeObjectURL(url);
      message.success(`已按运行 ${runId} 生成完整五 Sheet 报告`);
    } catch (error) { message.error((error as Error).message); }
    finally { setExporting(false); }
  };

  const columns = [
    { title: "排名", dataIndex: "rank_in_batch", key: "rank", width: 64, fixed: "left" as const },
    { title: "俄语查询词", dataIndex: "query", key: "query", width: 220, fixed: "left" as const, render: (value: string) => <Typography.Text strong>{value}</Typography.Text> },
    { title: "中文待审", dataIndex: "cn_gloss_draft", key: "cn", width: 220, render: (value: string) => <Typography.Text>{value}</Typography.Text> },
    {
      title: "形态 / 风险", key: "form", width: 320,
      render: (_: unknown, row: SelectionCandidate) => <Space direction="vertical" size={4}>
        <Typography.Text>{row.form_hypothesis_draft}</Typography.Text>
        <Space size={4} wrap>
          {row.manual_review_flags ? <Tag color="orange">人工：{row.manual_review_flags}</Tag> : <Tag>人工 flags：无</Tag>}
          {row.risk_flags ? <Tag color="red">{row.risk_flags}</Tag> : <Tag color="green">初筛无风险标记</Tag>}
        </Space>
      </Space>,
    },
    {
      title: "待核象限", key: "quadrant", width: 190,
      render: (_: unknown, row: SelectionCandidate) => <Tooltip title={`全部命中：${row.all_matched_quadrants}`}><Tag color="blue">{row.primary_quadrant}</Tag></Tooltip>,
    },
    { title: "分数", dataIndex: "Opportunity_Score", key: "score", width: 90, render: (value: number | null, row: SelectionCandidate) => <Tooltip title={`${row.score_status}；${row.data_quality_status}`}>{number(value)}</Tooltip> },
    { title: "count 热度", dataIndex: "count", key: "count", width: 120, render: (value: number | null) => number(value) },
    { title: "no_int", dataIndex: "usersWithoutInterectionShare", key: "noInt", width: 100, render: (value: number | null) => number(value, "%") },
    { title: "ca", dataIndex: "ca", key: "ca", width: 90, render: (value: number | null) => number(value, "%") },
    { title: "ord 买家", dataIndex: "ord", key: "ord", width: 100, render: (value: number | null) => number(value) },
    { title: "searchToOrd", dataIndex: "searchUsersToOrdUsers", key: "searchToOrd", width: 125, render: (value: number | null) => number(value, "%") },
    { title: "avgPrice", dataIndex: "avgCaRub", key: "avgPrice", width: 120, render: (value: number | null) => number(value, " ₽") },
    { title: "卖家", dataIndex: "uniqSellers", key: "sellers", width: 90, render: (value: number | null) => number(value) },
    { title: "零结果", dataIndex: "zrShare", key: "zero", width: 100, render: (value: number | null) => number(value, "%") },
    {
      title: "调研链接", key: "links", width: 210, fixed: "right" as const,
      render: (_: unknown, row: SelectionCandidate) => <Space size={4}>
        <Button size="small" href={row.ozon_search_url} target="_blank" rel="noreferrer">Ozon</Button>
        <Button size="small" href={row.yandex_search_url} target="_blank" rel="noreferrer">Yandex</Button>
        <Button size="small" href={row.wordstat_url} target="_blank" rel="noreferrer">Wordstat</Button>
      </Space>,
    },
  ];

  return <Space direction="vertical" size={16} style={{ width: "100%" }}>
    <Space wrap>
      <Button icon={<ArrowLeftOutlined />} onClick={onBack}>返回搜索查询</Button>
      <Button icon={<ReloadOutlined />} onClick={() => query.refetch()}>刷新当前候选</Button>
    </Space>
    <Alert type="warning" showIcon message="查询行不是独立方向或合格 SKU，更不是立项、采购或上架授权" description="Top30 只是待核调研排序；同词序簇和相关词必须合并调研，不足 30 条不凑数。后续仍须真实供货、准确身份与变体、合规、真实成本及独立复核。" />
    <QueryState query={query} emptyText="暂无可用选品分析">
      {data => <>
        <Card title="批次与过滤漏斗" extra={<Button type="primary" icon={<DownloadOutlined />} loading={exporting} onClick={() => download(data.runId)}>下载同 runId 完整 XLSX</Button>}>
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <Typography.Text>runId：<Typography.Text code>{data.runId}</Typography.Text> · anchorAt：{data.anchorAt || "N/A"} · 页数：{data.run.pageCount ?? "N/A"}/{data.run.expectedPages ?? "N/A"}</Typography.Text>
            <Typography.Text type="secondary" style={{ overflowWrap: "anywhere" }}>批次 SHA-256：{data.hash} · 算法：{data.algorithmVersion} · 配置 SHA-256：{data.configHash}</Typography.Text>
            <Space wrap size="large">
              <Statistic title="原始行" value={data.filterFunnel.rawRows} />
              <Statistic title="异常隔离" value={data.filterFunnel.invalidRows} />
              <Statistic title="精确重复移除" value={data.filterFunnel.exactDuplicatesRemoved} />
              <Statistic title="治理过滤" value={data.filterFunnel.governanceFiltered} />
              <Statistic title="进入明细" value={data.filterFunnel.eligibleRows} />
              <Statistic title="Top30 实际" value={data.filterFunnel.top30Actual} />
            </Space>
            <Typography.Text type="secondary">守恒校验：明细 + 治理过滤 + 异常/重复 = {data.filterFunnel.conservedRows} 行；缺失或不完整批次会明确失败，不回退其他 run。</Typography.Text>
          </Space>
        </Card>
        <Card title="四象限统计（主象限；均为待核假设）">
          <Space wrap size="large">
            {Object.entries(data.quadrantCounts).map(([label, count]) => <Statistic key={label} title={label} value={count} />)}
          </Space>
        </Card>
        <Alert type="info" showIcon message="指标与后续门禁" description={<Space direction="vertical" size={4}>
          <span>Seller days_7 的日历起止与时区未知；count 不可跨词累加。ord 是下单独立买家而非订单/件数，gmv 是查询归因订购金额而非结算收入，avgCaRub 是市场均价而非 CPC 或本店可实现成交价。</span>
          <span>Wordstat：{data.wordstat.status}，未请求、未补 0、未混入评分。</span>
          <span>真实成本未齐时不计算 10%/15% 成本上限：持续净利率 ≥10% 才可测、≥15% 优先；完整 8 图 + 双视频与独立复核未完成前不得上架。</span>
          <span>{data.mandatoryPendingActions}</span>
        </Space>} />
        <Card title={`Top30 待核查询行（实际 ${data.top30.length} 条）`}>
          <Table<SelectionCandidate>
            rowKey="query"
            columns={columns}
            dataSource={data.top30}
            pagination={false}
            size="small"
            scroll={{ x: 2400 }}
            locale={{ emptyText: "本批没有通过专项象限、评分、商业意图、风险、价格带及人工身份闸门的候选；不凑数" }}
          />
        </Card>
      </>}
    </QueryState>
  </Space>;
}
