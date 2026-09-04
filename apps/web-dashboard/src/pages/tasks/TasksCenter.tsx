// TasksCenter — merged task pages as tabs: queue / failed
import { Tabs } from "antd";
import { useSearchParams } from "react-router-dom";
import PageContainer from "../../components/PageContainer";
import TaskMonitor from "./TaskMonitor";
import FailedProducts from "./FailedProducts";

const TAB_KEYS = ["queue", "failed"];

export default function TasksCenter() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab") || "queue";
  const activeKey = TAB_KEYS.includes(tabParam) ? tabParam : "queue";

  const handleChange = (key: string) => {
    const params = new URLSearchParams(searchParams);
    params.set("tab", key);
    setSearchParams(params, { replace: true });
  };

  return (
    <PageContainer title="任务与失败" subTitle="导入任务队列与失败任务重试">
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
