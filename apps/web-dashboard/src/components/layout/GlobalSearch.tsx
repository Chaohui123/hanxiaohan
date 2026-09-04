// GlobalSearch — Ctrl+K 全局搜索（S7）：页面跳转 + 商品搜索
// Header 上的只读入口框点击弹 Modal；输入防抖 300ms，结果分「页面 / 商品」两组，
// 键盘 ↑↓ 选择、Enter 跳转、Esc 关闭，不引第三方 cmdk 库
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Empty, Input, List, Modal, Spin, Typography, theme } from "antd";
import { FileOutlined, SearchOutlined, ShoppingOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { useProductSearch } from "../../api/promo-api";

interface PageEntry {
  name: string;
  path: string;
}

// 页面清单：13 个菜单页 + Center 页的 Tab 深链
const PAGE_ENTRIES: PageEntry[] = [
  { name: "工作台", path: "/" },
  { name: "大盘分析", path: "/market" },
  { name: "选品上架", path: "/listing" },
  { name: "库存与价格", path: "/inventory" },
  { name: "竞品监控", path: "/competitor" },
  { name: "订单管理", path: "/orders" },
  { name: "采购支付", path: "/purchase-pay" },
  { name: "售后工单", path: "/aftersales" },
  { name: "推广中心", path: "/promo" },
  { name: "推广中心 · 决策", path: "/promo?tab=decision" },
  { name: "推广中心 · 效果", path: "/promo?tab=effect" },
  { name: "推广中心 · 调价历史", path: "/promo?tab=pricing" },
  { name: "任务与失败", path: "/tasks" },
  { name: "任务与失败 · 队列", path: "/tasks?tab=queue" },
  { name: "任务与失败 · 失败任务", path: "/tasks?tab=failed" },
  { name: "运行监控", path: "/monitoring" },
  { name: "知识库", path: "/rag" },
  { name: "店铺与插件", path: "/settings" },
  { name: "店铺与插件 · 店铺", path: "/settings?tab=stores" },
  { name: "店铺与插件 · 插件", path: "/settings?tab=plugin" },
];

interface ResultItem {
  kind: "page" | "product";
  key: string;
  title: string;
  sub: string;
  path: string;
}

export default function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [debounced, setDebounced] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { token } = theme.useToken();

  // 输入防抖 300ms
  useEffect(() => {
    const t = setTimeout(() => setDebounced(keyword.trim()), 300);
    return () => clearTimeout(t);
  }, [keyword]);

  const { data: products, isFetching } = useProductSearch(debounced);

  // Ctrl+K / Cmd+K 全局唤起/收起；输入框聚焦时不拦截
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(e.ctrlKey || e.metaKey)) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 页面组：空关键词时只列 13 个主页面（不含 Tab 深链），有关键词时按名称/路径模糊匹配
  const pageItems: ResultItem[] = useMemo(() => {
    const q = debounced.toLowerCase();
    const entries = q
      ? PAGE_ENTRIES.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
      : PAGE_ENTRIES.filter((p) => !p.path.includes("?"));
    return entries.map((p) => ({ kind: "page" as const, key: `page:${p.path}`, title: p.name, sub: p.path, path: p.path }));
  }, [debounced]);

  // 商品组：仅在有搜索词时请求；暂无商品详情页，统一跳 /inventory
  const productItems: ResultItem[] = useMemo(
    () =>
      (debounced ? products || [] : []).map((p) => ({
        kind: "product" as const,
        key: `product:${p.offerId}`,
        title: p.name,
        sub: `${p.price ?? 0} ₽ · 评分 ${p.rating ?? "-"} · 销量 ${p.salesCount ?? "-"}`,
        path: "/inventory",
      })),
    [products, debounced],
  );

  const allItems = useMemo(() => [...pageItems, ...productItems], [pageItems, productItems]);

  // 结果集变化回到第一项；选中项保持可见
  useEffect(() => { setActiveIndex(0); }, [debounced, products]);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const close = () => {
    setOpen(false);
    setKeyword("");
    setDebounced("");
    setActiveIndex(0);
  };

  const go = (item: ResultItem) => {
    close();
    navigate(item.path);
  };

  const onSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, allItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const item = allItems[activeIndex];
      if (item) go(item);
    }
  };

  const groupHeader = (text: string) => (
    <Typography.Text type="secondary" style={{ display: "block", padding: "8px 12px 4px", fontSize: 12 }}>
      {text}
    </Typography.Text>
  );

  const renderItem = (item: ResultItem, globalIndex: number) => {
    const active = globalIndex === activeIndex;
    return (
      <List.Item
        key={item.key}
        onClick={() => go(item)}
        onMouseEnter={() => setActiveIndex(globalIndex)}
        style={{
          cursor: "pointer",
          padding: "8px 12px",
          borderRadius: token.borderRadius,
          background: active ? token.colorFillSecondary : undefined,
        }}
      >
        <span data-active={active || undefined}
          style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minWidth: 0 }}>
          {item.kind === "page"
            ? <FileOutlined style={{ color: token.colorTextSecondary }} />
            : <ShoppingOutlined style={{ color: token.colorTextSecondary }} />}
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>{item.sub}</Typography.Text>
        </span>
      </List.Item>
    );
  };

  return (
    <>
      <Input
        readOnly
        placeholder="搜索页面 / 商品"
        prefix={<SearchOutlined style={{ color: token.colorTextQuaternary }} />}
        suffix={<Typography.Text keyboard style={{ fontSize: 11 }}>Ctrl K</Typography.Text>}
        style={{ width: 220, cursor: "pointer" }}
        onClick={() => setOpen(true)}
      />
      <Modal
        open={open}
        onCancel={close}
        footer={null}
        closable={false}
        width={560}
        destroyOnClose
        styles={{ body: { paddingTop: 4 } }}
      >
        <Input
          autoFocus
          size="large"
          prefix={<SearchOutlined />}
          suffix={isFetching ? <Spin size="small" /> : null}
          placeholder="搜索页面或商品…"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={onSearchKeyDown}
        />
        <div ref={listRef} style={{ maxHeight: 360, overflow: "auto", marginTop: 4 }}>
          {allItems.length === 0 && !isFetching ? (
            <Empty description="没有匹配的页面或商品" style={{ padding: 24 }} />
          ) : (
            <>
              {pageItems.length > 0 && groupHeader("页面")}
              <List size="small" split={false} dataSource={pageItems} renderItem={renderItem} />
              {productItems.length > 0 && groupHeader("商品")}
              <List size="small" split={false} dataSource={productItems}
                renderItem={(item, i) => renderItem(item, pageItems.length + i)} />
            </>
          )}
        </div>
        <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, padding: "6px 12px 0", marginTop: 4 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>↑↓ 选择 · Enter 跳转 · Esc 关闭</Typography.Text>
        </div>
      </Modal>
    </>
  );
}
