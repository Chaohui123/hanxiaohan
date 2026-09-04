// TasksCenter — merged task pages as tabs: queue / failed
import { Tabs } from "antd";
import { useSearchParams } from "react-router-dom";
import PageContainer from "../../components/PageContainer";
import TaskMonitor from "./TaskMonitor";
import FailedProducts from "./FailedProducts";
import { useDashboardTasks } from "../../api/dashboard-api";
import { useFailedProducts } from "../../api/task-api";

const TAB_KEYS = ["queue", "failed"];

export default function TasksCenter() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab") || "queue";
  const activeKey = TAB_KEYS.includes(tabParam) ? tabParam : "queue";

  // 与 Tab 内组件共用 queryKey 缓存，新鲜度标注取当前 Tab 的主查询
  const queueQuery = useDashboardTasks("all");
  const failedQuery = useFailedProducts();
  const updatedAt = activeKey === "failed" ? failedQuery.dataUpdatedAt : queueQuery.dataUpdatedAt;

  const handleChange = (key: string) => {
    const params = new URLSearchParams(searchParams);
    params.set("tab", key);
    setSearchParams(params, { replace: true });
  };

  return (
    <PageContainer title="任务与失败" subTitle="导入任务队列与失败任务重试" updatedAt={updatedAt}>
      <Tabs
        activeKey={activeKey}
        onChange={handleChange}
        items={[
          { key: "queue", label: "队列", children: <TaskMonitor /> },
          { key: "failed", label: "失败任务", children: <FailedProducts /> },
        ]}
      />
    </PageContainer>
  );
}
