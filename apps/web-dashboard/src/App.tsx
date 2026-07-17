import { Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route, Link, useLocation, Navigate } from "react-router-dom";
import { Layout, Menu, Spin, theme } from "antd";
import {
  DashboardOutlined, UploadOutlined, ShoppingCartOutlined,
  InboxOutlined, CustomerServiceOutlined, ShopOutlined,
  MonitorOutlined, MenuFoldOutlined, MenuUnfoldOutlined,
  RocketOutlined, EyeOutlined, LineChartOutlined, FundOutlined, DatabaseOutlined,
  DollarOutlined,
} from "@ant-design/icons";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAppStore } from "./stores/app-store";
import { ErrorBoundary } from "./components/ErrorBoundary";

// Lazy-loaded page components — reduces initial bundle size by ~80%
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Listing = lazy(() => import("./pages/Listing"));
const Orders = lazy(() => import("./pages/Orders"));
const Inventory = lazy(() => import("./pages/Inventory"));
const Aftersales = lazy(() => import("./pages/Aftersales"));
const Stores = lazy(() => import("./pages/Stores"));
const Monitoring = lazy(() => import("./pages/Monitoring"));
const Login = lazy(() => import("./pages/Login"));
const Promo = lazy(() => import("./pages/Promo"));
const Competitor = lazy(() => import("./pages/Competitor"));
const PricingHistory = lazy(() => import("./pages/PricingHistory"));
const PromoEffect = lazy(() => import("./pages/PromoEffect"));
const RagKnowledge = lazy(() => import("./pages/RagKnowledge"));
const PurchasePay = lazy(() => import("./pages/PurchasePay"));
const TaskMonitor = lazy(() => import("./pages/TaskMonitor"));
const FailedProducts = lazy(() => import("./pages/FailedProducts"));

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

const menuItems = [
  { key: "/", icon: <DashboardOutlined />, label: <Link to="/">仪表盘</Link> },
  { key: "/listing", icon: <UploadOutlined />, label: <Link to="/listing">产品上架</Link> },
  { key: "/orders", icon: <ShoppingCartOutlined />, label: <Link to="/orders">订单管理</Link> },
  { key: "/inventory", icon: <InboxOutlined />, label: <Link to="/inventory">库存管理</Link> },
  { key: "/aftersales", icon: <CustomerServiceOutlined />, label: <Link to="/aftersales">售后管理</Link> },
  { key: "/stores", icon: <ShopOutlined />, label: <Link to="/stores">店铺管理</Link> },
  { key: "/monitoring", icon: <MonitorOutlined />, label: <Link to="/monitoring">系统监控</Link> },
  { key: "/promo", icon: <RocketOutlined />, label: <Link to="/promo">推广决策</Link> },
  { key: "/competitor", icon: <EyeOutlined />, label: <Link to="/competitor">竞品监控</Link> },
  { key: "/pricing-history", icon: <LineChartOutlined />, label: <Link to="/pricing-history">调价历史</Link> },
  { key: "/promo-effect", icon: <FundOutlined />, label: <Link to="/promo-effect">推广效果</Link> },
  { key: "/rag", icon: <DatabaseOutlined />, label: <Link to="/rag">知识库</Link> },
  { key: "/purchase-pay", icon: <DollarOutlined />, label: <Link to="/purchase-pay">采购支付</Link> },
  { key: "/tasks", icon: <MonitorOutlined />, label: <Link to="/tasks">任务监控</Link> },
  { key: "/failed", icon: <RocketOutlined />, label: <Link to="/failed">失败重试</Link> },
];

function AppLayout() {
  const { sidebarCollapsed, toggleSidebar } = useAppStore();
  const { token: themeToken } = theme.useToken();
  const location = useLocation();

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
        <Header style={{ padding: "0 16px", background: themeToken.colorBgContainer, display: "flex", alignItems: "center", borderBottom: `1px solid ${themeToken.colorBorderSecondary}` }}>
          <span onClick={toggleSidebar} style={{ fontSize: 18, cursor: "pointer", marginRight: 16 }}>
            {sidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          </span>
          <span style={{ fontSize: 14, color: themeToken.colorTextSecondary }}>Ozon 跨境电商自动化运营系统</span>
        </Header>
        <Content style={{ margin: 16, padding: 24, background: themeToken.colorBgContainer, borderRadius: 8, overflow: "auto" }}>
          <ErrorBoundary>
            <Suspense fallback={<PageLoader />}>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/listing" element={<Listing />} />
                <Route path="/orders" element={<Orders />} />
                <Route path="/inventory" element={<Inventory />} />
                <Route path="/aftersales" element={<Aftersales />} />
                <Route path="/stores" element={<Stores />} />
                <Route path="/monitoring" element={<Monitoring />} />
                <Route path="/promo" element={<Promo />} />
                <Route path="/competitor" element={<Competitor />} />
                <Route path="/pricing-history" element={<PricingHistory />} />
                <Route path="/promo-effect" element={<PromoEffect />} />
                <Route path="/rag" element={<RagKnowledge />} />
                <Route path="/purchase-pay" element={<PurchasePay />} />
                <Route path="/tasks" element={<TaskMonitor />} />
                <Route path="/failed" element={<FailedProducts />} />
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
