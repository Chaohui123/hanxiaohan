import { useState } from "react";
import { Card, Input, Button, message, Space, Typography, Avatar, theme } from "antd";
import { KeyOutlined, LoginOutlined } from "@ant-design/icons";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAppStore } from "../stores/app-store";
import { api } from "../api/client";

const { Title, Text } = Typography;

export default function Login() {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const { setApiKey: saveToken } = useAppStore();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { token } = theme.useToken();

  const handleLogin = async () => {
    const pwd = password.trim();
    if (!pwd) {
      message.warning("请输入登录密码");
      return;
    }

    setLoading(true);
    try {
      // 独立密码模式：密码换 dashboard token（7 天有效），不再接触主 API Key
      const resp = await api.post("/api/auth/login", { password: pwd });
      const data = (resp as { data?: { token?: string } })?.data;
      if (!data?.token) throw new Error("登录响应异常，请重试");

      saveToken(data.token);
      message.success("登录成功");
      navigate("/", { replace: true });
    } catch (err) {
      const msg = (err as Error).message || "登录失败";
      // axios 拦截器对 401 会清 key 跳 /login——登录页原地无影响
      if (msg.includes("密码错误")) {
        message.error("密码错误，请重试");
      } else {
        message.error(msg);
      }
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
      <Card style={{ width: 360, boxShadow: "0 8px 32px rgba(0,0,0,0.2)" }}>
        <Space direction="vertical" size="large" style={{ width: "100%", textAlign: "center" }}>
          <div>
            <Avatar shape="square" size={48} style={{ backgroundColor: token.colorPrimary, fontSize: 24 }}>O</Avatar>
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
            placeholder="输入登录密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
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
            登录密码由管理员设置（服务器环境变量 DASHBOARD_PASSWORD）
          </Text>
        </Space>
      </Card>
    </div>
  );
}
