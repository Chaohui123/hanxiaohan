import React from "react";
import ReactDOM from "react-dom/client";
import { ConfigProvider } from "antd";
import App from "./App";
import { getThemeConfig } from "./theme";
import { useAppStore } from "./stores/app-store";
import "antd/dist/reset.css";

// zustand store 是模块级状态，与 ConfigProvider 无上下文依赖，可在组件内用 hook 订阅
function Root() {
  const darkMode = useAppStore((s) => s.darkMode);
  return (
    <ConfigProvider theme={getThemeConfig(darkMode)}>
      <App />
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
