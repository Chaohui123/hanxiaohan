// SettingsCenter — merged low-frequency config pages as tabs: stores / plugin
import { Tabs } from "antd";
import { useSearchParams } from "react-router-dom";
import PageContainer from "../../components/PageContainer";
import Stores from "./Stores";
import PluginGuide from "./PluginGuide";

const TAB_KEYS = ["stores", "plugin"];

export default function SettingsCenter() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab") || "stores";
  const activeKey = TAB_KEYS.includes(tabParam) ? tabParam : "stores";

  const handleChange = (key: string) => {
    const params = new URLSearchParams(searchParams);
    params.set("tab", key);
    setSearchParams(params, { replace: true });
  };

  return (
    <PageContainer title="店铺与插件" subTitle="店铺配置与 1688 采集插件">
      <Tabs
        activeKey={activeKey}
        onChange={handleChange}
        items={[
          { key: "stores", label: "店铺", children: <Stores /> },
          { key: "plugin", label: "插件", children: <PluginGuide /> },
        ]}
      />
    </PageContainer>
  );
}
