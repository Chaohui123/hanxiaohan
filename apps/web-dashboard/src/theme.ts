// 设计 Token（方案 §5.1）— ConfigProvider 全局注入
// 暗色主题留待 S7：届时切换 algorithm 为 theme.darkAlgorithm 即可
import { theme } from "antd";
import type { ThemeConfig } from "antd";

export const themeConfig: ThemeConfig = {
  algorithm: theme.defaultAlgorithm,
  token: {
    colorPrimary: "#2563eb",
    borderRadius: 8,
    colorBgLayout: "#f5f7fa",
    fontFamily: "Inter, -apple-system, 'PingFang SC', sans-serif",
  },
  components: {
    Table: { headerBg: "#fafbfc", cellPaddingBlock: 10 },
    Card: { paddingLG: 20 },
    Statistic: { titleFontSize: 13, contentFontSize: 24 },
  },
};
