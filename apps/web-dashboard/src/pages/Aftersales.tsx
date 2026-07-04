import { Card, Table, Tag } from "antd";
import { aftersalesApi } from "../api/client";
import { useQuery } from "@tanstack/react-query";

const typeColors: Record<string, string> = { refund: "red", return: "orange", exchange: "blue", complaint: "purple", question: "green" };
const statusColors: Record<string, string> = { pending: "orange", processing: "blue", resolved: "green", rejected: "red" };

export default function Aftersales() {
  const { data, isLoading } = useQuery({ queryKey: ["aftersales"], queryFn: () => aftersalesApi.list() });
  const cases = (Array.isArray((data as { data?: unknown[] })?.data) ? (data as { data: unknown[] }).data : []);

  return (
    <Card title="售后工单">
      <Table dataSource={cases} rowKey="id" loading={isLoading} size="small"
        columns={[
          { title: "订单号", dataIndex: "posting_number", width: 130 },
          { title: "类型", dataIndex: "type", render: (t: string) => <Tag color={typeColors[t] || "default"}>{t}</Tag> },
          { title: "状态", dataIndex: "status", render: (s: string) => <Tag color={statusColors[s] || "default"}>{s}</Tag> },
          { title: "原因", dataIndex: "reason" },
          { title: "退款", dataIndex: "refund_amount_rub", render: (v: number) => v ? `${v} ₽` : "-" },
          { title: "时间", dataIndex: "created_at", width: 160 },
        ]}
      />
    </Card>
  );
}
