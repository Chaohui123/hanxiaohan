import { BrowserRouter, Routes, Route, Link, useLocation } from "react-router-dom";
import { Layout, Menu, theme } from "antd";
import {
  DashboardOutlined, UploadOutlined, ShoppingCartOutlined,
  InboxOutlined, CustomerServiceOutlined, ShopOutlined,
  MonitorOutlined, MenuFoldOutlined, MenuUnfoldOutlined,
} from "@ant-design/icons";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAppStore } from "./stores/app-store";
import Dashboard from "./pages/Dashboard";
import Listing from "./pages/Listing";
import Orders from "./pages/Orders";
import Inventory from "./pages/Inventory";
import Aftersales from "./pages/Aftersales";
import Stores from "./pages/Stores";
import Monitoring from "./pages/Monitoring";

const { Header, Sider, Content } = Layout;
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

const menuItems = [
  { key: "/", icon: <DashboardOutlined />, label: <Link to="/">仪表盘</Link> },
  { key: "/listing", icon: <UploadOutlined />, label: <Link to="/listing">产品上架</Link> },
  { key: "/orders", icon: <ShoppingCartOutlined />, label: <Link to="/orders">订单管理</Link> },
  { key: "/inventory", icon: <InboxOutlined />, label: <Link to="/inventory">库存管理</Link> },
  { key: "/aftersales", icon: <CustomerServiceOutlined />, label: <Link to="/aftersales">售后管理</Link> },
  { key: "/stores", icon: <ShopOutlined />, label: <Link to="/stores">店铺管理</Link> },
  { key: "/monitoring", icon: <MonitorOutlined />, label: <Link to="/monitoring">系统监控</Link> },
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
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/listing" element={<Listing />} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/inventory" element={<Inventory />} />
            <Route path="/aftersales" element={<Aftersales />} />
            <Route path="/stores" element={<Stores />} />
            <Route path="/monitoring" element={<Monitoring />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppLayout />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
