import { Card, Table, Tag } from "antd";
import { useStores } from "../../api/settings-api";
import QueryState from "../../components/QueryState";

export default function Stores() {
  const storesQuery = useStores();

  return (
    <Card title="店铺管理">
      <QueryState query={storesQuery} emptyText="暂无店铺配置">
        {(stores) => (
          <Table dataSource={stores} rowKey="store_id" size="small" scroll={{ x: "max-content" }}
            columns={[
              { title: "店铺ID", dataIndex: "store_id" },
              { title: "名称", dataIndex: "store_name" },
              { title: "分组", dataIndex: "group_name" },
              { title: "状态", dataIndex: "active", render: (a: number) => <Tag color={a ? "green" : "red"}>{a ? "活跃" : "停用"}</Tag> },
              { title: "API Key", dataIndex: "apiKey", ellipsis: true },
            ]}
          />
        )}
      </QueryState>
    </Card>
  );
}
