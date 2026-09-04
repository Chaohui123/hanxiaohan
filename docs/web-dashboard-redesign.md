# Web Dashboard 前端重构设计方案

> 版本：v2（2026-09-04）｜v1 依据：全量代码调研；v2 增补：竞品调研（店小秘/马帮/芒果店长/领星 + Shopify Admin/Polaris + Ozon Seller 后台 + Medusa/Saleor）
> 原则：每一步可独立部署验证；不中断在用的业务链路；先修契约、再重组、后美化。

---

## 0. 竞品调研结论（v2 新增）

### 0.1 跨境 ERP（店小秘/领星等）可借鉴的模式

1. **订单按状态机流水线组织**：待审核→待处理→待打单→已交运→已完成，每个状态页只出现该状态可做的操作。"清空每个 Tab = 完成发货工作"，状态即任务队列。
2. **批量操作是第一公民**（批量审核/申请单号/打印/搁置），行内只留轻操作；列表微交互（数量≥2 标红、运单号点击弹轨迹）。
3. **工作台 = 卡片化 + 待办 + 预警**（领星范式）：实时数据卡自动刷新 + 运营待办 + 补货建议/绩效异常预警，卡片可自定义布局。待办和预警是跨境 ERP 首页的灵魂，纯图表看板不合格。
4. **报表按"管理问题"组织**（赚不赚钱/哪个品行不行/库存健不健康），不按数据表组织；产品详情内嵌"指标+订单+库存+售后+预警"多 Tab（一个品一个档案）。
5. **采购/缺货建议前置为列表页**（不是报表），一键生成采购单。

### 0.2 国际电商后台（Shopify/Medusa）可借鉴的模式

1. **顶栏三件套**：全局搜索（Ctrl+K）、告警铃铛（未读角标）、店铺切换器；Settings 沉底永不混入业务导航。
2. **首页是"行动入口"不是图表墙**：KPI 卡（点击钻取明细）+ 紧急行动清单（点击直达处理页）+ 系统自动洞察（带"为什么"链接）。
3. **Index/Detail 双模式**：列表页搜索+筛选+排序一体化、批量操作、行点击进详情；详情页面包屑+状态 Badge+一个主按钮+次操作收溢出菜单。
4. **四态显式设计**：loading 骨架屏（禁整页 spinner）/ empty（插图+引导主行动）/ some / many。
5. **数据新鲜度显式表达**："更新于 X 分钟前"、含今天的数据段标记"进行中"、任务页提供自动刷新开关。
6. **告警分级流**：可预防的中断（即将超时发货）> 已发生的中断（上架被拒/支付失败）> 合规通知 > 资金事件 > 耗时任务完成；每条可标记已读、点击直达上下文。

### 0.3 反模式（不学）

- 不按客户类型拆多个独立产品（马帮）——我们单平台单产品内解决
- 一级模块不超过 7±2（店小秘 11-14 个过多）；不把"采集"单列一级（并入上架流水线）
- Ozon 官方后台中文支持差正是我们的价值点：中台必须全中文、术语贴合中国卖家习惯

### 0.4 对本方案的修订

- 订单页从"表格+筛选"升级为**状态机 Tab**（§3.2 修订）
- 工作台从"统计卡堆叠"升级为 **KPI 卡 + 紧急行动清单 + 告警分级流**（§3.3 新增）
- 四态规范与数据新鲜度写入设计系统（§5.3 修订）
- 顶栏三件套（全局搜索/告警铃铛/店铺切换）提前到 S2 与 IA 同做（§7 修订）

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

### 3.2b 订单页状态机化（v2 修订，对标店小秘/领星流水线）

订单页从"表格+状态下拉筛选"升级为**状态 Tab 流水线**，每个 Tab 只显示该状态可做的操作：

```
[待处理] [待发货(临近超时⚠)] [运输中] [已取消/售后] [全部]
```

- **待处理**（awaiting_packaging）：批量采购触发、行内"查看采购"
- **待发货**（awaiting_deliver）：批量发货、运单号填写；**发货截止时间倒计时标红**（Ozon 超时影响店铺评分，硬约束）
- **运输中**：物流轨迹链接
- 每个 Tab 右上角显示该状态订单数（角标 = 任务量）
- "清空每个 Tab"即完成当日发货工作——状态即任务队列

### 3.3 工作台重设计（v2 新增，核心页面）

从"统计卡堆叠"改为三层结构（对标 Shopify Home + 领星工作台）：

```
┌────────────────────────────────────────────────┐
│ KPI 卡行（3-5 张，大数字+环比+sparkline，点击钻取） │
│ 今日销售额 ₽ / 今日订单 / 广告花费 / 库存预警数      │
├────────────────────────────────────────────────┤
│ 🔴 需要你处理（紧急行动清单，点击直达）              │
│  • 2 个订单临近发货超时（剩 6h）→ /orders?tab=ship  │
│  • 1 个商品调价失败（Ozon 拒绝）→ /promo?tab=pricing│
│  • 3 条死信待处理 → /tasks?tab=dead               │
├────────────────────────────────────────────────┤
│ 📈 趋势与洞察（近 7 日销售趋势图 + 系统洞察）         │
└────────────────────────────────────────────────┘
```

- KPI 卡不超过 5 张（Tableau 眼动研究：第 4-5 张卡之后无人看）
- 紧急行动清单数据源：orders（shipment_deadline 临近）+ promo_audit_log（失败动作）+ task failed 计数——全部是已有数据
- 每个指标必须能回答"看到这个数我会做什么"，答不上来的不上墙

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

### 5.3 状态与反馈规范（v2 修订：引入四态 + 新鲜度 + 告警分级）

- 全部数据请求收敛 react-query；轮询统一 `refetchInterval`（禁用原生 setInterval），页面隐藏自动暂停（`refetchIntervalInBackground: false`）
- **四态组件**：`<QueryState>` 显式区分 loading（骨架屏 Skeleton，保持页面轮廓，禁整页 spinner）/ error（带重试按钮）/ empty（插图+一句话+引导主行动按钮，如"还没有商品？去选品"）/ 正常
- **数据新鲜度**：指标卡角落统一标注"更新于 X 分钟前"；含当天的数据段在图表上标记"进行中"
- **告警分级**（AlertBanner 升级为 Header 铃铛+抽屉的告警流）：
  🔴 可预防的中断（即将超时发货、库存将尽）＞ 🟠 已发生的中断（上架被拒/支付失败/调价失败）＞ 🟡 合规与平台通知 ＞ 💰 资金事件（采购扣款）＞ ✅ 耗时任务完成（批量上架完成）
  每条告警可标记已读、点击直达上下文页面
- 操作类按钮一律 mutation + loading + 成功/失败 message + 失败回滚（Promo 开关已是范式，推广到全部）
- 金额/汇率/百分比/时间统一格式化工具（`formatRub`、`formatDateTime` 用 utils/time 同源的展示口径）

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
| **S2 IA 重组 + 顶栏骨架** | 菜单分组、页面合并（路由重定向）、PageContainer；Header 三件套骨架（店铺切换器+告警铃铛+登出；全局搜索框先占位） | 旧链接全部跳转正确；无 404；菜单 6 组 | S1 |
| **S3 工作台重设计 + 真实数据** | KPI 卡行（点击钻取）+ 紧急行动清单（发货超时/调价失败/死信）+ 趋势图；Promo 决策统计、周趋势接 /stats/weekly；移除全部"示例数据"标注 | 工作台每条行动可点击直达；页面无假数据 | S1 S2 |
| **S4 能力界面化 + 订单状态机** | 订单页状态 Tab 流水线（发货超时倒计时标红、批量发货）；批量导入恢复（bulk/import/xlsx）；订单对账入口；售后操作按钮；物流 Tab | 每个入口点击后有真实 API 响应；订单 Tab 角标计数正确 | S2 |
| **S5 API 层收敛 + 四态组件** | 8 个直调页面改造、消灭二次脱壳、QueryState 四态全页面铺开、数据新鲜度标注 | 全局 grep 无裸 fetch/直调；每个数据视图有四态 | S2 |
| **S6 视觉升级** | theme.ts、Sider 分组菜单美化、响应式统一、空态插图 | 走查清单全过 | S2 |
| **S7 暗色主题 + 全局搜索**（可选） | darkAlgorithm + 图表适配 + Ctrl+K 全局搜索（跨页面跳转/商品搜索） | 切换无样式断裂；搜索可达任意页面 | S6 |

**推荐执行顺序**：S1 → S2 → S3 → S4 → S5 → S6 →（S7 可选）。
S1-S4 是功能正确性，S5-S7 是工程与体验。每步完成后跑 `tsc -b` + `vitest` + 构建镜像部署验证。

---

## 8. 明确不做

- 不引入 tailwind / CSS-in-JS 库（antd token 体系足够，避免双样式体系）
- 不重写为 Next.js / SSR（内部工具无 SEO 需求，Vite SPA 足够）
- 不动后端业务逻辑（只补缺端点）
- 不做 RBAC 多角色（单店铺单密钥工具，JWT 属 Phase 2 既有规划）
- 旧版服务端直出 HTML 仪表盘（dashboard-html.route.ts）保留作降级备份，不下线
