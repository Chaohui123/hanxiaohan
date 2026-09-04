import { Row, Col, Card, Statistic, Table, Spin } from "antd";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line, Legend } from "recharts";
import dayjs from "dayjs";
import { usePromoCost, usePricingHistory, useCopyHistory } from "../../api/promo-api";
import { useWeeklyStats } from "../../api/dashboard-api";
import { useChartTheme } from "../../components/ThemedChart";

export default function PromoEffect() {
  const { data: costData } = usePromoCost();
  const { data: pricingData, isLoading: pLoading } = usePricingHistory(30);
  const { data: copyData } = useCopyHistory(30);
  const { data: weekly } = useWeeklyStats();
  const chartTheme = useChartTheme();

  const cost = costData || {};
  const adjustments = pricingData || [];
  const copies = copyData || [];

  // Pricing effect chart
  const pricingChart = adjustments.slice(0, 10).map((a) => ({
    name: String(a.name || a.offerId || "").slice(0, 20),
    before: Number(a.salesBefore || 0),
    after: Number(a.salesAfter || 0),
  }));

  // 近 7 日销售趋势（daily_sales 真实数据）
  const trendData = (weekly?.byDay || []).map((p) => ({
    date: dayjs(p.date).format("MM-DD"),
    revenue: Math.round(p.revenue),
  }));

  return (
    <div>
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={6}><Card><Statistic title="广告花费" value={Number(cost?.adSpend || 0)} prefix="₽" /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="付费收入" value={Number(cost?.paidRevenue || 0)} prefix="₽" /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="ROI" value={Number(cost?.roi || 0).toFixed(2)} suffix="x" valueStyle={{ color: Number(cost?.roi) >= 2 ? "#10b981" : "#f59e0b" }} /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="自然流占比" value={`${(Number(cost?.organicRevenue || 0) / Math.max(Number(cost?.totalRevenue || 1), 1) * 100).toFixed(0)}%`} /></Card></Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={12}>
          <Card title="调价效果对比 (Before/After)">
            {pricingChart.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={pricingChart}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.gridStroke} />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: chartTheme.tickFill }} />
                  <YAxis tick={{ fill: chartTheme.tickFill }} />
                  <Tooltip contentStyle={chartTheme.tooltipStyle} />
                  <Legend />
                  <Bar dataKey="before" fill="#94a3b8" name="调前销量" />
                  <Bar dataKey="after" fill="#3b82f6" name="调后销量" />
                </BarChart>
              </ResponsiveContainer>
            ) : <div style={{ textAlign: "center", padding: 40, color: "#94a3b8" }}>暂无调价数据</div>}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="近 7 日销售趋势">
            {trendData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={trendData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.gridStroke} />
                  <XAxis dataKey="date" tick={{ fill: chartTheme.tickFill }} />
                  <YAxis tick={{ fill: chartTheme.tickFill }} />
                  <Tooltip contentStyle={chartTheme.tooltipStyle} />
                  <Legend />
                  <Line type="monotone" dataKey="revenue" stroke="#10b981" name="销售额 ₽" />
                </LineChart>
              </ResponsiveContainer>
            ) : <div style={{ textAlign: "center", padding: 40, color: "#94a3b8" }}>暂无销售数据</div>}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={12}>
          <Card title="调价历史">
            {pLoading ? <Spin /> : (
              <Table
                dataSource={adjustments.slice(0, 10).map((a, i) => ({
                  key: i, name: a.name, offerId: a.offerId,
                  oldPrice: Number(a.oldPrice || 0).toFixed(0),
                  newPrice: Number(a.newPrice || 0).toFixed(0),
                }))}
                columns={[
                  { title: "商品", dataIndex: "name", key: "name", ellipsis: true },
                  { title: "原价", dataIndex: "oldPrice", key: "oldPrice", width: 80 },
                  { title: "新价", dataIndex: "newPrice", key: "newPrice", width: 80 },
                ]}
                pagination={false} size="small" scroll={{ x: "max-content" }}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="文案优化记录">
            <Table
              dataSource={copies.slice(0, 10).map((c, i) => ({
                key: i, name: c.name, offerId: c.offerId,
                titleRu: String(c.titleRu || "").slice(0, 40),
              }))}
              columns={[
                { title: "商品", dataIndex: "name", key: "name", ellipsis: true },
                { title: "俄语标题", dataIndex: "titleRu", key: "titleRu", ellipsis: true },
              ]}
              pagination={false} size="small" scroll={{ x: "max-content" }}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
