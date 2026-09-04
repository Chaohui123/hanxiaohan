// Dashboard — 工作台三层结构：KPI 卡行（点击钻取）→「需要你处理」行动清单 → 近 7 日趋势 + 最近上架
import { useNavigate } from "react-router-dom";
import { Row, Col, Card, Statistic, Table, Tag, Spin } from "antd";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import dayjs from "dayjs";
import { useDashboardStats, useWeeklyStats } from "../api/dashboard-api";
import { useQueueStats, useTaskListings } from "../api/task-api";
import { useLlmStats } from "../api/monitor-api";
import ActionList from "../components/ActionList";
import { useChartTheme } from "../components/ThemedChart";

interface KpiCard {
  title: string;
  value: number;
  prefix?: string;
  suffix?: string;
  color?: string;
  path: string;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const todayStr = dayjs().format("YYYY-MM-DD");
  const fromStr = dayjs().subtract(6, "day").format("YYYY-MM-DD");

  const { data: dash, isLoading } = useDashboardStats();
  const { data: queue } = useQueueStats();
  const { data: llm } = useLlmStats();
  const { data: listings } = useTaskListings();
  const { data: weekly } = useWeeklyStats(fromStr, todayStr);
  const chartTheme = useChartTheme();

  if (isLoading) return <Spin size="large" style={{ display: "block", margin: "100px auto" }} />;

  const d = dash || {};
  const q = queue || {};
  const l = llm || {};

  // 近 7 日趋势（含今天，标记"今天"）；无订单的日期补 0 避免断档
  const byDayMap = new Map((weekly?.byDay || []).map((p) => [p.date, p]));
  const trendData = Array.from({ length: 7 }, (_, i) => {
    const date = dayjs().subtract(6 - i, "day").format("YYYY-MM-DD");
    const point = byDayMap.get(date);
    return {
      label: i === 6 ? "今天" : dayjs(date).format("MM-DD"),
      orders: point?.orders || 0,
      revenue: Math.round(point?.revenue || 0),
    };
  });
  const todaySales = trendData[trendData.length - 1];

  const pendingTasks = (Number(q.queued) || 0) + (Number(q.processing) || 0);
  const todayTokens = Number(l.todayTokens) || Number(d.todayTokens) || 0;

  const kpis: KpiCard[] = [
    { title: "今日销售额", value: Math.round(todaySales.revenue), prefix: "₽", path: "/orders" },
    { title: "今日订单", value: todaySales.orders, suffix: "单", path: "/orders" },
    { title: "待处理任务", value: pendingTasks, suffix: "个", color: pendingTasks > 0 ? "#f59e0b" : "#10b981", path: "/tasks" },
    { title: "今日Token", value: todayTokens, suffix: `/ ${(Number(l.dailyLimit) || 500000).toLocaleString()}`, path: "/monitoring" },
  ];

  return (
    <div>
      {/* 第一层：KPI 卡行 */}
      <Row gutter={[16, 16]}>
        {kpis.map((kpi) => (
          <Col xs={12} sm={6} key={kpi.title}>
            <Card hoverable style={{ cursor: "pointer" }} onClick={() => navigate(kpi.path)}>
              <Statistic title={kpi.title} value={kpi.value} prefix={kpi.prefix} suffix={kpi.suffix}
                valueStyle={kpi.color ? { color: kpi.color } : undefined} />
            </Card>
          </Col>
        ))}
      </Row>

      {/* 第二层：需要你处理（行动清单） */}
      <ActionList />

      {/* 第三层：近 7 日销售趋势 */}
      <Card title="近 7 日销售趋势" style={{ marginTop: 16 }}>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={trendData}>
            <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.gridStroke} />
            <XAxis dataKey="label" tick={{ fill: chartTheme.tickFill }} />
            <YAxis yAxisId="orders" allowDecimals={false} tick={{ fill: chartTheme.tickFill }} />
            <YAxis yAxisId="revenue" orientation="right" tick={{ fill: chartTheme.tickFill }} />
            <Tooltip contentStyle={chartTheme.tooltipStyle} />
            <Legend />
            <Area yAxisId="orders" type="monotone" dataKey="orders" name="订单数" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.15} />
            <Area yAxisId="revenue" type="monotone" dataKey="revenue" name="销售额 ₽" stroke="#10b981" fill="#10b981" fillOpacity={0.15} />
          </AreaChart>
        </ResponsiveContainer>
      </Card>

      {/* 最近上架 */}
      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col xs={24} lg={12}>
          <Card title="最近上架" size="small">
            <Table dataSource={(listings || []).slice(0, 5)}
              rowKey="id" size="small" pagination={false} scroll={{ x: 400 }}
              columns={[
                { title: "URL", dataIndex: "sourceUrl", ellipsis: true, width: 200 },
                { title: "状态", dataIndex: "status", render: (s: string) => <Tag color={s === "done" ? "green" : "red"}>{s}</Tag> },
                { title: "时间", dataIndex: "createdAt", width: 160 },
              ]} />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
