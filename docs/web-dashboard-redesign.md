# Web Dashboard 前端重构设计方案

> 版本：v1（2026-09-04）｜依据：全量代码调研（27 个源文件 + 后端 40+ 路由文件交叉核对）
> 原则：每一步可独立部署验证；不中断在用的业务链路；先修契约、再重组、后美化。

---

## 1. 现状诊断

### 1.1 结构性问题（为什么要重构，而不是继续打补丁）

| 问题 | 事实 |
|---|---|
| 导航失控 | 17 个菜单平铺无分组（`App.tsx:54-72`），图标语义重复（/market 与 /pricing-history 同图标等 3 组） |
| 同一数据散落多页 | 失败任务出现在 3 个页面、Token 用量 2 处、调价历史 2 处、推广花费/ROI 2 处、插件采集记录 2 处（其中 1 处是死代码） |
| 契约断裂 | `GET /api/inventory/items` 后端不存在（库存页永远为空）；`plugin-download` 端点不存在；Promo"当前决策计划"字段与后端代理响应不匹配（恒为"—"）；`analyze` 路由双前缀错位 404 |
| 假数据混入 | Promo"今日决策=1/成功率=92"、PromoEffect 周趋势 4 周数组（已临时标注"示例数据"）——**而后端 `GET /api/stats/daily`、`/api/stats/weekly` 已有真实数据可接** |
| 能力闲置 | 后端约 40% 的端点前端从未调用：对账、物流 dashboard、售后操作、批量导入（`/api/bulk/import` 已存在但前端按钮已移除）、SKU 映射管理等 |

### 1.2 技术债

- API 层三种风格并存（client.ts 平铺对象 / promo-api.ts 双层 hooks / 页面裸 fetch、直调），响应拦截器脱壳一次后页面仍普遍二次脱壳
- zustand store 只有 4 个字段且 `currentStore` 无 UI 消费；组件内状态各自为政
- 无样式体系：零 .css 文件，全部 antd 内联 `style={{}}`，响应式断点只有一半页面做了
- 无登出按钮；轮询策略混乱（7 个 query 各自 15/30/60s，AlertBanner 用原生 setInterval 绕开 react-query）

---

## 2. 设计目标

1. **一个信息只在一个地方看**（消除同源数据多页重复）
2. **界面上没有假数据、没有死按钮**（接真接口或明确移除）
3. **后端已有的能力尽量界面化**（对账、物流、售后操作、批量导入）
4. **运营动线导向**：每天打开能按"发生了什么 → 要我做什么 → 点了就办完"走完

---

## 3. 信息架构（IA）重组

### 3.1 新导航结构（6 组 15 项，替代 17 项平铺）

```
📊 概览
   ├─ 工作台          /            （今日指标 + 待办 + 告警聚合）
   └─ 大盘分析        /market

📦 商品
   ├─ 选品上架        /listing     （含批量导入恢复 — 后端 /api/bulk/import 已就绪）
   ├─ 库存与价格      /inventory   （修契约后落地：商品列表+改价+库存）
   └─ 竞品监控        /competitor

📋 交易
   ├─ 订单管理        /orders      （含对账入口：/orders/reconcile 已存在未用）
   ├─ 采购支付        /purchase-pay
   └─ 售后工单        /aftersales  （接入 resolve/reject/auto-reply 操作）

🚀 推广
   └─ 推广中心        /promo       （合并 Promo + PromoEffect + PricingHistory 三页为
                                     Tab 页：决策/效果/调价历史）

🔧 系统
   ├─ 任务与失败      /tasks       （合并 TaskMonitor + FailedProducts，Tab：队列/失败/死信）
   ├─ 运行监控        /monitoring
   ├─ 知识库          /rag
   └─ 店铺与插件      /settings    （Stores + PluginGuide 合并；含店铺切换、登出）
```

路由迁移：旧路径全部 301 重定向（`/promo-effect` → `/promo?tab=effect`，`/failed` → `/tasks?tab=failed`，`/pricing-history` → `/promo?tab=pricing`，`/plugin` → `/settings?tab=plugin`，`/stores` → `/settings`）。

### 3.2 页面合并明细

| 合并 | 理由 |
|---|---|
| Promo + PromoEffect + PricingHistory → 推广中心（3 Tab） | 同源数据（promo/cost、pricing-history），割裂展示导致重复 |
| TaskMonitor + FailedProducts + Dashboard 失败任务表 → 任务与失败 | `/api/task/failed` 一处三看；Dashboard 只留告警横幅入口 |
| Stores + PluginGuide → 店铺与插件（2 Tab） | 都是低频配置项 |
| Dashboard 的 Token 卡 → 链到 /monitoring | Token 详情只在监控页 |

---

## 4. 数据与契约修复（设计的硬约束）

| # | 问题 | 方案 |
|---|---|---|
| C1 | 库存页永远空（`/api/inventory/items` 404） | 后端补 `GET /api/inventory/items`（复用 `GET /api/inventory` 的 product_performance+fallback 逻辑），前端接上真实列 |
| C2 | Promo"当前决策计划"恒为"—" | 后端 promo-agent `/health` 增加 `lastPlan` 摘要（id/createdAt/status/actionCount），api-services 代理透传，前端按真实字段渲染 |
| C3 | 假数据（今日决策/成功率/周趋势） | 后端补 `GET /api/promo/decision-stats`（读 promo_decisions+promo_audit_log 真实计数）；周趋势改接 `GET /api/stats/weekly`（daily_sales 真实数据） |
| C4 | plugin-download 死链 | 后端补 `GET /api/crawl/plugin-download`（打包 extensions/1688-assistant 为 zip/crx 流式返回）或移除按钮——**决策：实现端点** |
| C5 | 批量导入按钮已移除 | 恢复按钮，对接已存在的 `POST /api/bulk/import/xlsx` |
| C6 | analyze 双前缀错位 | 后端 analyze.route.ts 内部路径去掉重复的 `/analyze` |
| C7 | 响应结构不统一导致二次脱壳 | 后端新端点统一 `{success, data}`；前端 api 层封装 `unwrap<T>()` 兼容两种旧结构，页面不再自行判断 |

---

## 5. 视觉与交互设计系统

### 5.1 设计 Token（写入 `src/theme.ts`，ConfigProvider 全局注入）

```ts
{
  token: {
    colorPrimary: "#2563eb",        // 品牌蓝（现行 #3b82f6 降一档，重数据场景更沉稳）
    borderRadius: 8,
    colorBgLayout: "#f5f7fa",
    fontFamily: "Inter, -apple-system, 'PingFang SC', sans-serif",
  },
  components: {
    Table:  { headerBg: "#fafbfc", cellPaddingBlock: 10 },
    Card:   { paddingLG: 20 },
    Statistic: { titleFontSize: 13, contentFontSize: 24 },
  }
}
```

### 5.2 布局规范

- Header 重做：左侧系统名，右侧 **店铺切换器**（激活 app-store.currentStore + `/api/stores`）、告警铃铛（AlertBanner 收敛为 Header 铃铛+抽屉，不再占页面顶部）、用户区（登出）
- Sider：分组菜单 + 分组标题；折叠时只留图标
- Content：`max-width: 1440px` 居中，页面级统一 `PageContainer` 组件（标题+副标题+操作区+内容）
- 卡片网格：`xs=24 sm=12 lg=8 xl=6` 四档统一；表格页 `scroll={{ x: 'max-content' }}` 兜底移动端

### 5.3 状态与反馈规范

- 全部数据请求收敛 react-query；轮询统一 `refetchInterval`（禁用原生 setInterval），页面隐藏自动暂停（`refetchIntervalInBackground: false`）
- 三态组件：`<QueryState loading error empty>` 统一加载/错误/空态（消灭 emoji 文案不一致）
- 金额/汇率/百分比/时间统一格式化工具（`formatRub`、`formatDateTime` 用 utils/time 同源的展示口径）
- 操作类按钮一律 mutation + loading + 成功/失败 message + 失败回滚（Promo 开关已是范式，推广到全部）

### 5.4 暗色主题

`algorithm: [theme.darkAlgorithm]` 切换，zustand 持久化偏好。Sider/表格/图表（recharts 轴色）适配。**放最后一步做**（价值/成本比最低）。

---

## 6. 技术架构调整

```
src/
├─ api/            全部收敛为「api 对象 + hooks」双层（现 promo-api 模式推广到全部）
│  ├─ client.ts    axios 实例 + unwrap 兼容层 + 统一错误事件
│  └─ *.ts         按业务域：dashboard / listing / order / inventory / promo / purchase / system
├─ components/
│  ├─ PageContainer.tsx / QueryState.tsx / StatCard.tsx / DataTable 约定
│  └─ layout/      AppHeader / AppSider / StoreSwitcher / NotificationDrawer
├─ stores/         app-store（增 theme、currentStore 持久化）
├─ theme.ts
└─ pages/          按新 IA 归位，每页一个目录（page.tsx + 局部组件）
```

- 消灭裸 fetch（PurchasePay 导出改用 api 封装流式下载）
- 路由集中 `routes.tsx`：懒加载 + 旧路径重定向上表
- ErrorBoundary 保持，QueryState 内部复用其错误 UI

---

## 7. 分步实施计划

> 每步独立提交、独立部署、可回滚。预估为一人天粒度。

| 步骤 | 内容 | 验收标准 | 依赖 |
|---|---|---|---|
| **S1 契约修复**（先后端） | C1/C2/C3/C4/C6 五个端点 + unwrap 兼容层 | 库存页有真实数据；决策计划卡显示真实计划；导出 CRX 可下载 | 无 |
| **S2 IA 重组** | 菜单分组、页面合并（路由重定向）、PageContainer 统一 | 旧链接全部跳转正确；无 404；菜单 6 组 | S1 |
| **S3 真实数据接入** | Promo 决策统计、PromoEffect 周趋势接 /stats/weekly；移除全部"示例数据"标注 | 页面无假数据 | S1 |
| **S4 能力界面化** | 批量导入恢复（bulk/import/xlsx）、订单对账入口、售后操作按钮、物流 Tab | 每个入口点击后有真实 API 响应 | S2 |
| **S5 API 层收敛** | 8 个直调页面改造、消灭二次脱壳、统一 QueryState | 全局 grep 无裸 fetch/直调 | S2 |
| **S6 视觉升级** | theme.ts、Header/Sider 重做、响应式统一、店铺切换器+登出 | 走查清单全过 | S2 |
| **S7 暗色主题** | darkAlgorithm + 图表适配 + 偏好持久化 | 切换无样式断裂 | S6 |

**推荐执行顺序**：S1 → S2 → S3 → S4 → S5 → S6 →（S7 可选）。
S1-S4 是功能正确性，S5-S7 是工程与体验。每步完成后跑 `tsc -b` + `vitest` + 构建镜像部署验证。

---

## 8. 明确不做

- 不引入 tailwind / CSS-in-JS 库（antd token 体系足够，避免双样式体系）
- 不重写为 Next.js / SSR（内部工具无 SEO 需求，Vite SPA 足够）
- 不动后端业务逻辑（只补缺端点）
- 不做 RBAC 多角色（单店铺单密钥工具，JWT 属 Phase 2 既有规划）
- 旧版服务端直出 HTML 仪表盘（dashboard-html.route.ts）保留作降级备份，不下线
