// SettingsCenter — merged low-frequency config pages as tabs: stores / plugin
import { Tabs } from "antd";
import { useSearchParams } from "react-router-dom";
import PageContainer from "../../components/PageContainer";
import Stores from "./Stores";
import PluginGuide from "./PluginGuide";
import { useStores, usePluginProducts } from "../../api/settings-api";

const TAB_KEYS = ["stores", "plugin"];

export default function SettingsCenter() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab") || "stores";
  const activeKey = TAB_KEYS.includes(tabParam) ? tabParam : "stores";

  // 与 Tab 内组件共用 queryKey 缓存，新鲜度标注取当前 Tab 的主查询
  const storesQuery = useStores();
  const pluginQuery = usePluginProducts();
  const updatedAt = activeKey === "plugin" ? pluginQuery.dataUpdatedAt : storesQuery.dataUpdatedAt;

  const handleChange = (key: string) => {
    const params = new URLSearchParams(searchParams);
    params.set("tab", key);
    setSearchParams(params, { replace: true });
  };

  return (
    <PageContainer title="店铺与插件" subTitle="店铺配置与 1688 采集插件" updatedAt={updatedAt}>
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
