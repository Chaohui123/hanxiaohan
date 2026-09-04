// Failed products — batch filter, batch retry
import { Card, Table, Tag, Button, Space, message } from "antd";
import { ReloadOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { useQueryClient } from "@tanstack/react-query";
import { useFailedProducts, useRetryBatch, useRetryTask } from "../../api/task-api";
import QueryState from "../../components/QueryState";

export default function FailedProducts() {
  const qc = useQueryClient();
  const failedQuery = useFailedProducts();
  const retryBatchMutation = useRetryBatch();
  const retryMutation = useRetryTask(["failed-products"]);

  const rows = failedQuery.data || [];

  return (
    <Card
      title={`失败任务 (${rows.length})`}
      extra={
        <Space>
          <Button icon={<ThunderboltOutlined />} type="primary" danger size="small"
            disabled={rows.length === 0}
            loading={retryBatchMutation.isPending}
            onClick={() => retryBatchMutation.mutate("all", {
              onSuccess: (r) => message.success(`批量重试完成: ${r?.retried || 0} 成功, ${r?.failed || 0} 失败`),
              onError: (e) => message.error((e as Error).message),
            })}>批量重试全部</Button>
          <Button icon={<ReloadOutlined />} size="small"
            onClick={() => qc.invalidateQueries({ queryKey: ["failed-products"] })}>刷新</Button>
        </Space>
      }
    >
      <QueryState query={failedQuery} emptyText="✅ 没有失败任务">
        {(list) => (
          <Table
            dataSource={list.map((r, i) => ({ ...r, key: i }))}
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
                render: (_: unknown, r) => (
                  <Button size="small" type="primary" danger icon={<ReloadOutlined />}
                    loading={retryMutation.isPending}
                    onClick={() => retryMutation.mutate(String(r.id), {
                      onSuccess: () => message.success("重跑已提交"),
                      onError: (e) => message.error((e as Error).message),
                    })}>重试</Button>
                ),
              },
            ]}
          />
        )}
      </QueryState>
    </Card>
  );
}
