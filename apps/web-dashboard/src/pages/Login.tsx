import { useState } from "react";
import { Card, Input, Button, message, Space, Typography } from "antd";
import { KeyOutlined, LoginOutlined } from "@ant-design/icons";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAppStore } from "../stores/app-store";
import { dashboardApi } from "../api/client";

const { Title, Text } = Typography;

export default function Login() {
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const { setApiKey: saveApiKey } = useAppStore();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const handleLogin = async () => {
    const key = apiKey.trim();
    if (!key) {
      message.warning("请输入 API Key");
      return;
    }

    setLoading(true);
    try {
      // Store key first so the API client can use it
      saveApiKey(key);

      // Verify by calling /health (bypasses auth) then /api/dashboard (requires auth)
      const health = await dashboardApi.health();
      if (!health) throw new Error("无法连接到服务器");

      // Try authenticated endpoint to verify key
      try {
        await dashboardApi.stats();
      } catch (err) {
        // If 401, the interceptor would have redirected. If other error, key might still be wrong.
        const msg = (err as Error).message;
        if (msg.includes("401") || msg.includes("UNAUTHORIZED") || msg.includes("Invalid")) {
          throw new Error("API Key 无效，请检查后重试");
        }
        // Other errors could be backend issues — allow entry
      }

      message.success("认证成功");
      navigate("/", { replace: true });
    } catch (err) {
      const { logout } = useAppStore.getState();
      logout();
      message.error((err as Error).message || "认证失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
    }}>
      <Card style={{ width: 400, boxShadow: "0 8px 32px rgba(0,0,0,0.2)" }}>
        <Space direction="vertical" size="large" style={{ width: "100%", textAlign: "center" }}>
          <div>
            <span style={{ fontSize: 48 }}>🛒</span>
            <Title level={2} style={{ marginTop: 8 }}>ONZO</Title>
            <Text type="secondary">Ozon 跨境电商自动化运营系统</Text>
          </div>

          {searchParams.get("reason") === "auth_required" && (
            <Text type="danger">
              {searchParams.get("message") || "需要认证才能访问"}
            </Text>
          )}

          <Input.Password
            prefix={<KeyOutlined />}
            placeholder="输入 API Key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onPressEnter={handleLogin}
            size="large"
            autoFocus
          />

          <Button
            type="primary"
            icon={<LoginOutlined />}
            loading={loading}
            onClick={handleLogin}
            block
            size="large"
          >
            登录
          </Button>

          <Text type="secondary" style={{ fontSize: 12 }}>
            在 .env 中设置 API_KEY，登录时输入相同的密钥
          </Text>
        </Space>
      </Card>
    </div>
  );
}
