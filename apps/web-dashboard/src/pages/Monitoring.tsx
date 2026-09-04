import { Card, Row, Col, Statistic, Table, Tag, Progress } from "antd";
import { useLlmStats, useFxRate, useScraperMetrics, usePipelineHealth } from "../api/monitor-api";
import { useFailedTasks } from "../api/task-api";
import PageContainer from "../components/PageContainer";

export default function Monitoring() {
  const llmQ = useLlmStats();
  const fxQ = useFxRate();
  const scraperQ = useScraperMetrics();
  const deadQ = useFailedTasks();
  const pipelineQ = usePipelineHealth();

  const l = llmQ.data || {};
  const f = fxQ.data || {};
  const s = scraperQ.data || {};
  const deadList = deadQ.data || [];
  const components = pipelineQ.data?.components || [];

  return (
    <PageContainer title="运行监控" subTitle="Token 用量、汇率、爬虫与管道健康" updatedAt={llmQ.dataUpdatedAt}>
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}><Card><Statistic title="Token用量" value={(Number(l.todayTokens) || 0).toLocaleString()} suffix={`/ ${(Number(l.dailyLimit) || 500000).toLocaleString()}`} />
          <Progress percent={Math.min(100, ((Number(l.todayTokens) || 0) / (Number(l.dailyLimit) || 500000)) * 100)} size="small" status={Number(l.todayTokens) > Number(l.dailyLimit || 500000) * 0.8 ? "exception" : "active"} /></Card></Col>
        <Col xs={24} sm={12} lg={6}><Card><Statistic title="汇率 CNY→RUB" value={Number(f.rate) || 0} suffix={f.reliable ? "✅" : "⚠️"} /></Card></Col>
        <Col xs={24} sm={12} lg={6}><Card><Statistic title="爬虫成功率" value={String(s.successRate ?? "N/A")} /></Card></Col>
        <Col xs={24} sm={12} lg={6}><Card><Statistic title="死信积压" value={deadList.length} valueStyle={{ color: deadList.length > 5 ? "#ef4444" : "#10b981" }} /></Card></Col>
      </Row>

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col xs={24} lg={12}>
          <Card title="外部依赖状态" size="small">
            {components.map((c) => (
              <div key={c.name} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid #f0f0f0" }}>
                <span>{c.name}</span>
                <Tag color={c.status === "ok" ? "green" : c.status === "degraded" ? "orange" : "red"}>{c.status} ({c.latencyMs}ms)</Tag>
              </div>
            ))}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="死信队列" size="small">
            <Table dataSource={deadList.slice(0, 5)} rowKey="id" size="small" pagination={false} scroll={{ x: "max-content" }}
              columns={[
                { title: "类型", dataIndex: "taskType", width: 80 }, { title: "错误", dataIndex: "errorMessage", ellipsis: true },
                { title: "重试", dataIndex: "retryCount", width: 50 },
              ]}
              locale={{ emptyText: "✅ 死信队列为空" }}
            />
          </Card>
        </Col>
      </Row>
    </PageContainer>
  );
}
