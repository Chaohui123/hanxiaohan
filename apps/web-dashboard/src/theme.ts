// 设计 Token（方案 §5.1）— ConfigProvider 全局注入
// S7 暗色主题（§5.4）：algorithm 随 darkMode 切换；colorBgLayout、Table.headerBg 是亮色专属覆盖，
// 暗色下不注入，交给 darkAlgorithm 的 token 默认值，避免暗色出现亮底
import { theme } from "antd";
import type { ThemeConfig } from "antd";

const baseToken: ThemeConfig["token"] = {
  colorPrimary: "#2563eb",
  borderRadius: 8,
  fontFamily: "Inter, -apple-system, 'PingFang SC', sans-serif",
};

const tableBase = { cellPaddingBlock: 10 };

/** 亮色主题（默认） */
export const themeConfig: ThemeConfig = {
  algorithm: theme.defaultAlgorithm,
  token: { ...baseToken, colorBgLayout: "#f5f7fa" },
  components: {
    Table: { ...tableBase, headerBg: "#fafbfc" },
    Card: { paddingLG: 20 },
    Statistic: { titleFontSize: 13, contentFontSize: 24 },
  },
};

/** 按模式生成主题配置：暗色切 darkAlgorithm 并去掉亮色专属覆盖 */
export function getThemeConfig(darkMode: boolean): ThemeConfig {
  if (!darkMode) return themeConfig;
  return {
    ...themeConfig,
    algorithm: theme.darkAlgorithm,
    token: { ...baseToken },
    components: { ...themeConfig.components, Table: { ...tableBase } },
  };
}
