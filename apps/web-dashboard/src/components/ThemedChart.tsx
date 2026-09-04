// useChartTheme — recharts 图表颜色随 antd 主题 token 派生（S7 暗色适配）：
// 亮色下 gridStroke 浅灰 / tickFill 深灰，暗色下自动变为深灰网格 / 浅色刻度，无需按模式分支
import { theme } from "antd";
import type { CSSProperties } from "react";

export interface ChartTheme {
  gridStroke: string;
  tickFill: string;
  tooltipStyle: CSSProperties;
}

export function useChartTheme(): ChartTheme {
  const { token } = theme.useToken();
  return {
    gridStroke: token.colorBorderSecondary,
    tickFill: token.colorTextSecondary,
    tooltipStyle: {
      backgroundColor: token.colorBgElevated,
      border: `1px solid ${token.colorBorderSecondary}`,
      borderRadius: token.borderRadius,
      color: token.colorText,
    },
  };
}
