// Ozon import task monitor — task list, progress, retry
import { Card, Table, Tag, Button, Select, Space, message } from "antd";
import { ReloadOutlined, SyncOutlined } from "@ant-design/icons";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useDashboardTasks } from "../../api/dashboard-api";
import { useRetryTask } from "../../api/task-api";
import QueryState from "../../components/QueryState";

export default function TaskMonitor() {
  const [status, setStatus] = useState<string>("all");
  const qc = useQueryClient();
  const tasksQuery = useDashboardTasks(status);

  const retryMutation = useRetryTask(["dashboard-tasks"]);

  const statusColor: Record<string, string> = {
    queued: "default", processing: "processing", done: "green", failed: "red",
  };

  return (
    <Card
      title="Ozon 导入任务监控"
      extra={
        <Space>
          <Select value={status} onChange={setStatus} size="small" style={{ width: 120 }}
            options={[
              { value: "all", label: "全部" }, { value: "queued", label: "排队中" },
              { value: "processing", label: "处理中" }, { value: "failed", label: "失败" },
              { value: "done", label: "已完成" },
            ]} />
          <Button icon={<SyncOutlined />} size="small" onClick={() => qc.invalidateQueries({ queryKey: ["dashboard-tasks"] })}>刷新</Button>
        </Space>
      }
    >
      <QueryState query={tasksQuery} emptyText={status === "all" ? "暂无任务记录" : "该状态下暂无任务"}>
        {(rows) => (
          <Table
            dataSource={rows.map((r, i) => ({ ...r, key: i }))}
            size="small"
            pagination={{ pageSize: 20 }}
            scroll={{ x: 600 }}
            columns={[
              { title: "Task ID", dataIndex: "id", width: 120, ellipsis: true },
              { title: "类型", dataIndex: "type", width: 80 },
              { title: "状态", dataIndex: "status", width: 90, render: (s: string) => <Tag color={statusColor[s] || "default"}>{s}</Tag> },
              { title: "店铺", dataIndex: "store_id", width: 80 },
              { title: "重试", dataIndex: "retry_count", width: 60, render: (v: number, r) => `${v}/${r.max_retries || 3}` },
              { title: "错误", dataIndex: "error_message", ellipsis: true, width: 200 },
              {
                title: "操作", width: 80,
                render: (_: unknown, r) =>
                  r.status === "failed" ? (
                    <Button size="small" type="primary" danger icon={<ReloadOutlined />}
                      loading={retryMutation.isPending}
                      onClick={() => retryMutation.mutate(String(r.id), {
                        onSuccess: () => message.success("重跑已提交"),
                        onError: (e) => message.error((e as Error).message),
                      })}>重跑</Button>
                  ) : null,
              },
            ]}
          />
        )}
      </QueryState>
    </Card>
  );
}
