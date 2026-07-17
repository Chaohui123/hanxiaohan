// Failed products — batch filter, batch retry
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, Table, Tag, Button, Space, message } from "antd";
import { ReloadOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { api } from "../api/client";

export default function FailedProducts() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["failed-products"],
    queryFn: () => api.get("/api/task/failed", { params: { limit: 200 } }),
    refetchInterval: 15_000,
  });

  const retryBatchMutation = useMutation({
    mutationFn: (filterType: string) => api.post("/api/task/deadletter/retry-batch", { filterType }),
    onSuccess: (res: unknown) => {
      const r = res as { data?: { retried?: number; failed?: number } };
      message.success(`批量重试完成: ${r?.data?.retried || 0} 成功, ${r?.data?.failed || 0} 失败`);
      qc.invalidateQueries({ queryKey: ["failed-products"] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const retryMutation = useMutation({
    mutationFn: (taskId: string) => api.post(`/api/task/retry/${taskId}`),
    onSuccess: () => { message.success("重跑已提交"); qc.invalidateQueries({ queryKey: ["failed-products"] }); },
    onError: (e: Error) => message.error(e.message),
  });

  const rows = (data as unknown as { data?: Array<Record<string, unknown>> })?.data || [];

  return (
    <Card
      title={`失败任务 (${rows.length})`}
      extra={
        <Space>
          <Button icon={<ThunderboltOutlined />} type="primary" danger size="small"
            disabled={rows.length === 0}
            onClick={() => retryBatchMutation.mutate("all")}>批量重试全部</Button>
          <Button icon={<ReloadOutlined />} size="small"
            onClick={() => qc.invalidateQueries({ queryKey: ["failed-products"] })}>刷新</Button>
        </Space>
      }
    >
      <Table
        dataSource={rows.map((r, i) => ({ ...r, key: i }))}
        loading={isLoading}
        size="small"
        pagination={{ pageSize: 30 }}
        scroll={{ x: 700 }}
        columns={[
          { title: "ID", dataIndex: "id", width: 100, ellipsis: true },
          { title: "类型", dataIndex: "task_type", width: 100 },
          { title: "店铺", dataIndex: "store_id", width: 80 },
          { title: "状态", dataIndex: "status", width: 100, render: (s: string) => <Tag color={s === "pending_retry" ? "orange" : "red"}>{s}</Tag> },
          { title: "错误", dataIndex: "error_message", ellipsis: true, width: 250 },
          {
            title: "操作", width: 80,
            render: (_: unknown, r: Record<string, unknown>) => (
              <Button size="small" type="primary" danger icon={<ReloadOutlined />}
                loading={retryMutation.isPending}
                onClick={() => retryMutation.mutate(r.id as string)}>重试</Button>
            ),
          },
        ]}
      />
    </Card>
  );
}
