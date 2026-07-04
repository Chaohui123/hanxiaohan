import React from "react";
import ReactDOM from "react-dom/client";
import { ConfigProvider, theme } from "antd";
import App from "./App";
import "antd/dist/reset.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm, token: { colorPrimary: "#3b82f6", borderRadius: 6 } }}>
      <App />
    </ConfigProvider>
  </React.StrictMode>
);
