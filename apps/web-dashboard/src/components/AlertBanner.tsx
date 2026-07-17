// Red alert popup banner — stock, token, rate-limit warnings
import { useEffect, useState } from "react";
import { Alert, Space } from "antd";
import { api } from "../api/client";

interface AlertItem { type: string; level: string; message: string; count: number }

export default function AlertBanner() {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;
    async function fetchAlerts() {
      try {
        const res = await api.get("/api/dashboard/alerts") as unknown as { data?: AlertItem[] };
        setAlerts(res?.data || []);
      } catch { /* ignore */ }
    }
    fetchAlerts();
    timer = setInterval(fetchAlerts, 30_000);
    return () => clearInterval(timer);
  }, []);

  if (alerts.length === 0) return null;

  return (
    <Space direction="vertical" style={{ width: "100%", marginBottom: 16 }}>
      {alerts.map((a) => (
        <Alert
          key={a.type}
          type={a.level === "critical" ? "error" : "warning"}
          banner
          closable
          message={
            <span>
              {a.level === "critical" ? "🔴" : "🟡"} {a.message}
              {a.type === "stock_out" && " — 立即补货!"}
              {a.type === "token_limit" && " — 暂停AI调用!"}
              {a.type === "failed_tasks" && " — 前往失败任务页批量重试"}
            </span>
          }
        />
      ))}
    </Space>
  );
}