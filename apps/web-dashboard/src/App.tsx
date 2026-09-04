import { Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route, Link, useLocation, useNavigate, useSearchParams, Navigate } from "react-router-dom";
import { Layout, Menu, Spin, theme, Button, Space, Avatar, message } from "antd";
import type { MenuProps } from "antd";
import {
  DashboardOutlined, LineChartOutlined, RocketOutlined, DatabaseOutlined,
  EyeOutlined, ShoppingOutlined, PayCircleOutlined, CustomerServiceOutlined,
  FundOutlined, MonitorOutlined, HeartOutlined, BookOutlined,
  SettingOutlined, MenuFoldOutlined, MenuUnfoldOutlined, LogoutOutlined,
} from "@ant-design/icons";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAppStore } from "./stores/app-store";
import { ErrorBoundary } from "./components/ErrorBoundary";
import StoreSwitcher from "./components/layout/StoreSwitcher";
import AlertBell from "./components/layout/AlertBell";

// Lazy-loaded page components — reduces initial bundle size by ~80%
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Listing = lazy(() => import("./pages/Listing"));
const Orders = lazy(() => import("./pages/Orders"));
const Inventory = lazy(() => import("./pages/Inventory"));
const Aftersales = lazy(() => import("./pages/Aftersales"));
const Monitoring = lazy(() => import("./pages/Monitoring"));
const Login = lazy(() => import("./pages/Login"));
const Competitor = lazy(() => import("./pages/Competitor"));
const RagKnowledge = lazy(() => import("./pages/RagKnowledge"));
const PurchasePay = lazy(() => import("./pages/PurchasePay"));
const MarketAnalysis = lazy(() => import("./pages/MarketAnalysis"));
const PromoCenter = lazy(() => import("./pages/promo/PromoCenter"));
const TasksCenter = lazy(() => import("./pages/tasks/TasksCenter"));
const SettingsCenter = lazy(() => import("./pages/settings/SettingsCenter"));

const { Header, Sider, Content } = Layout;
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

/** Page-level loading spinner shown during lazy chunk load. */
function PageLoader() {
  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: 300 }}>
      <Spin size="large" tip="加载中..." />
    </div>
  );
}

/** Redirect to /login if not authenticated */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAppStore((s) => s.isAuthenticated);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** Legacy route redirect: keeps incoming query params, optionally overriding `tab`. */
function LegacyRedirect({ to, tab }: { to: string; tab?: string }) {
  const [searchParams] = useSearchParams();
  const params = new URLSearchParams(searchParams);
  if (tab) params.set("tab", tab);
  const qs = params.toString();
  return <Navigate to={`${to}${qs ? `?${qs}` : ""}`} replace />;
}

// Grouped navigation (S2 IA restructure) — 5 groups replacing 17 flat items
const menuItems: MenuProps["items"] = [
  {
    type: "group",
    label: "概览",
    children: [
      { key: "/", icon: <DashboardOutlined />, label: <Link to="/">工作台</Link> },
      { key: "/market", icon: <LineChartOutlined />, label: <Link to="/market">大盘分析</Link> },
    ],
  },
  {
    type: "group",
    label: "商品",
    children: [
      { key: "/listing", icon: <RocketOutlined />, label: <Link to="/listing">选品上架</Link> },
      { key: "/inventory", icon: <DatabaseOutlined />, label: <Link to="/inventory">库存与价格</Link> },
      { key: "/competitor", icon: <EyeOutlined />, label: <Link to="/competitor">竞品监控</Link> },
    ],
  },
  {
    type: "group",
    label: "交易",
    children: [
      { key: "/orders", icon: <ShoppingOutlined />, label: <Link to="/orders">订单管理</Link> },
      { key: "/purchase-pay", icon: <PayCircleOutlined />, label: <Link to="/purchase-pay">采购支付</Link> },
      { key: "/aftersales", icon: <CustomerServiceOutlined />, label: <Link to="/aftersales">售后工单</Link> },
    ],
  },
  {
    type: "group",
    label: "推广",
    children: [
      { key: "/promo", icon: <FundOutlined />, label: <Link to="/promo">推广中心</Link> },
    ],
  },
  {
    type: "group",
    label: "系统",
    children: [
      { key: "/tasks", icon: <MonitorOutlined />, label: <Link to="/tasks">任务与失败</Link> },
      { key: "/monitoring", icon: <HeartOutlined />, label: <Link to="/monitoring">运行监控</Link> },
      { key: "/rag", icon: <BookOutlined />, label: <Link to="/rag">知识库</Link> },
      { key: "/settings", icon: <SettingOutlined />, label: <Link to="/settings">店铺与插件</Link> },
    ],
  },
];

function AppLayout() {
  const { sidebarCollapsed, toggleSidebar, logout } = useAppStore();
  const { token: themeToken } = theme.useToken();
  const location = useLocation();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout(); // clears localStorage "onzo-api-key" + app-store auth state
    message.success("已登出");
    navigate("/login", { replace: true });
  };

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider
        trigger={null}
        collapsible
        collapsed={sidebarCollapsed}
        theme="dark"
        style={{ borderRight: `1px solid ${themeToken.colorBorderSecondary}` }}
      >
        <div style={{ height: 48, margin: 12, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 18, fontWeight: 700 }}>
          {sidebarCollapsed ? "🛒" : "🛒 ONZO"}
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
        />
      </Sider>
      <Layout>
        <Header style={{ padding: "0 16px", background: themeToken.colorBgContainer, display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${themeToken.colorBorderSecondary}` }}>
          <span style={{ display: "flex", alignItems: "center" }}>
            <span onClick={toggleSidebar} style={{ fontSize: 18, cursor: "pointer", marginRight: 16 }}>
              {sidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            </span>
            <Avatar shape="square" size={24} style={{ backgroundColor: themeToken.colorPrimary, fontSize: 14, marginRight: 8 }}>O</Avatar>
            <span style={{ fontSize: 14, color: themeToken.colorTextSecondary }}>Ozon 跨境电商自动化运营系统</span>
          </span>
          <Space size={16}>
            <StoreSwitcher />
            <AlertBell />
            <Button type="text" icon={<LogoutOutlined />} onClick={handleLogout}>
              登出
            </Button>
          </Space>
        </Header>
        <Content style={{ margin: 16, padding: 24, background: themeToken.colorBgContainer, borderRadius: 8, overflow: "auto" }}>
          <ErrorBoundary>
            <Suspense fallback={<PageLoader />}>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/market" element={<MarketAnalysis />} />
                <Route path="/listing" element={<Listing />} />
                <Route path="/inventory" element={<Inventory />} />
                <Route path="/competitor" element={<Competitor />} />
                <Route path="/orders" element={<Orders />} />
                <Route path="/purchase-pay" element={<PurchasePay />} />
                <Route path="/aftersales" element={<Aftersales />} />
                <Route path="/promo" element={<PromoCenter />} />
                <Route path="/tasks" element={<TasksCenter />} />
                <Route path="/monitoring" element={<Monitoring />} />
                <Route path="/rag" element={<RagKnowledge />} />
                <Route path="/settings" element={<SettingsCenter />} />
                {/* Legacy route redirects (keep query, inject target tab) */}
                <Route path="/promo-effect" element={<LegacyRedirect to="/promo" tab="effect" />} />
                <Route path="/pricing-history" element={<LegacyRedirect to="/promo" tab="pricing" />} />
                <Route path="/failed" element={<LegacyRedirect to="/tasks" tab="failed" />} />
                <Route path="/plugin" element={<LegacyRedirect to="/settings" tab="plugin" />} />
                <Route path="/stores" element={<LegacyRedirect to="/settings" />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </Content>
      </Layout>
    </Layout>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={
            <Suspense fallback={<PageLoader />}>
              <Login />
            </Suspense>
          } />
          <Route path="*" element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          } />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
