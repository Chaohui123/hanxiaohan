import { Card, Table, Tag, Button, Space, message } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { storeApi } from "../api/client";
import { useQuery } from "@tanstack/react-query";

export default function Stores() {
  const { data, isLoading } = useQuery({ queryKey: ["stores"], queryFn: () => storeApi.list() });
  const stores = (Array.isArray((data as { data?: unknown[] })?.data) ? (data as { data: unknown[] }).data : []);

  return (
    <Card title="店铺管理" extra={<Button icon={<PlusOutlined />} onClick={() => message.info("使用 POST /api/stores 添加店铺")}>添加店铺</Button>}>
      <Table dataSource={stores} rowKey="store_id" loading={isLoading} size="small"
        columns={[
          { title: "店铺ID", dataIndex: "store_id" },
          { title: "名称", dataIndex: "store_name" },
          { title: "分组", dataIndex: "group_name" },
          { title: "状态", dataIndex: "active", render: (a: number) => <Tag color={a ? "green" : "red"}>{a ? "活跃" : "停用"}</Tag> },
          { title: "API Key", dataIndex: "apiKey", ellipsis: true },
        ]}
      />
    </Card>
  );
}
