# ONZO 现行技术架构

> 2026-11-05 按当前 workspace、Docker Compose、无货源测品规则、订单/竞品链路和运维文档复核。早期 v2 中的 Qdrant、GLM-5.2、DeepSeek-VL2、影刀 RPA、Next.js 与 Phase 1 启动清单已作为历史设计移出本文，原文件已备份，不得据此实施。

## 一、当前技术边界

| 层 | 当前实现 | 边界 |
|---|---|---|
| 主业务 | TypeScript、Node.js 22+、pnpm monorepo、Express 4 | 沿用现有分包与配置入口 |
| 看板 | React/Vite | 不是 Next.js 设计稿所描述的已完成重构 |
| 生产数据 | PostgreSQL 16 + pgvector | 当前向量字段为 `vector(1024)` |
| 缓存与协调 | Redis 7 | 用于缓存、限流/调度协调等，不替代主数据库 |
| 本地/降级 | SQLite | 仅 standalone；不能按 SQLite 处理生产故障 |
| 调度 | api-services 内建 scheduler | n8n 仅作可选可视化编排 |
| 媒体与运营工具 | 现有 Python/Node 脚本、ffmpeg、Whisper | 不再一概禁止 Python |
| 部署 | Docker Compose、Caddy、deploy-watch | 生产使用 `production` profile |

Qdrant 不是当前组件。早期“单机只用 SQLite”“禁止 Redis”“一期禁止浏览器”等约束均已废止。

## 二、运行时组成

```text
浏览器/运营人员/飞书
        │
        ▼
Caddy HTTPS
        │
        ▼
api-services ───── PostgreSQL + pgvector
   │    │  └────── Redis
   │    │
   │    ├───────── Web 看板
   │    ├───────── ops-agent：巡检、通知
   │    ├───────── promo-agent：经营分析与建议
   │    └───────── Whisper：转录
   │
   ├─ Ozon Seller / Performance API
   ├─ 1688 货源与素材工具
   └─ 内建 scheduler、备份与知识维护

独立服务器竞品采集容器 → 公开前台快照 → api-services → PostgreSQL
```

- `apps/api-services` 提供 API、RAG、数据库迁移、scheduler、Webhook 和订单/运营服务。
- `apps/web-dashboard` 提供看板，不把设计文档中的规划能力视为已交付。
- `apps/ops-agent`、`apps/promo-agent` 通过 API 和共享包协作，不绕过生产权限边界。
- Caddy 只在 `production` profile；`full` 的监控能力不等于自动包含 Caddy，HTTPS 全栈需同时选择相应 profile。

## 三、核心业务数据流

### 3.1 无货源选品、测品与上架（2026-11-05）

```text
独立真实需求（Yandex 商品词搜索量或 Ozon 后台/前台需求数据）
  → 跨境竞争参考、供货、准确变体与关键参数
  → 持续经营净利 10%–15% + 一周 CPS 测品预算
  → 完整 8 图/双视频制作与独立质量验收
  → Kimi 主 Agent 执行 Ozon 写入
  → 属性、图片、视频、价格、5–10 件测品额度、活动逐项回读
  → 小批量出单后拿样、自拍更新替代、成本与建品脚本回写
  → 经营复盘、放量或停止、知识入库
```

同类跨境卖家的动销只能参考，不能独立证明需求；初筛可用同变体供应商标重与保守成本，累计 3 个有效付款订单后拿样、最迟不超过 5 单，供应商授权不设核验或停止项。真实需求、商品身份、安全/关键参数、供货、经济或合规证据不足仍须停止，内容未齐不得上架。Ozon import 是全量替换，补属性必须回写建品脚本；模型分析不等于生产授权。

代码中保留的旧 `plugin-publish-graph`、简化利润试算和 `/api/product/plugin-select-publish` 不得作为现行新品上架路径：其默认利润与简化字段不代表本 SOP 的真实需求、完整成本、8 图双视频、CPS 台账和生产回读验收。新品只能由 Kimi 按上述流程复核后执行，不能调用旧自动发布接口绕过闸门。

### 3.2 订单与通知

- Webhook 接收层校验 seller_id，签名存在时验签；实际 Ozon 报文使用 `message_type`、`order_number`、`uuid`。
- 合法事件落库后快速响应，drain 异步消费并做幂等处理；API 定时同步补偿丢失事件。
- 订单处理、库存事务与通知分别记录真实结果，异常不得静默吞掉。
- PostgreSQL 使用单连接事务；订单标识使用能容纳真实 Ozon 长整数的字段。

### 3.3 定价与竞品

- 竞品正式采集走服务器调度，不使用已停用的本机定时抓取。
- 快照区分展示价、常规价、评分未知与直接可比性；旧 `legacy_unknown` 不推测回填。
- 失败、dry-run、子集、UNCERTAIN 与正式完整批次分开，未对账不得覆盖最新有效数据。
- 单元经济纳入采购、包装、实际线路/重量、佣金、收单、国际运输、退货和 CPS 等成本。
- 当前 `PROMO_AUTO_DECISION=false`，模型只提供分析；调价须专项授权、备份和完整生产回读。

### 3.4 Direct 与周复盘

- ONZO Ads Manager 用于 Direct 只读 Reports，marketplace campaign 设置仍走后台。
- 报表保留部分当天数据、完整周窗口和失败状态；0 转化时实际 CPA 不可计算。
- 周复盘核验竞品快照、last-run、经营数据和 Direct 报表新鲜度，再由模型分析、Kimi 汇总；模型不直接改广告或商品。

## 四、数据、RAG 与备份

- PostgreSQL 是生产事实数据主存储，pgvector 支撑售后、竞品、选品、文案和运营 playbook。
- Embedding 当前使用智谱 embedding-3，调用维度必须显式为 1024，并与 `EMBEDDING_DIMENSIONS`、表结构一致。
- RAG 查询失败按规则降级并记录；新知识走 `knowledgeGate + persistToPlaybook`，替代条目存在才允许清理被取代内容。
- Redis 不作为唯一事实源。SQLite 仅用于 standalone 或明确的本地工具，不与生产 PostgreSQL 混称。
- API 内建备份默认每 6 小时执行 `pg_dump → gzip`，配置加密时输出 `.enc`；恢复必须按运维手册演练，不能用复制 SQLite 文件代替。

## 五、模型与生产权限

| 角色 | 当前职责 |
|---|---|
| Kimi 主 Agent | 浏览器/生产 API、SOP 执行、知识维护、终审与生产回读 |
| Astra | 高价值经济测算和重大决策攻坚 |
| Gemini 4 Hydrogen | 日常代码、桌面任务分析、文案辅助与视觉理解；经 `scripts/gemini-hydrogen.py` 留痕 |
| Luna | 批量文案精修 |
| Gemini Argon / Omni / Nano | Argon 负责高风险多模态交叉复核，Omni/Nano 负责图像、视频生成；Edge 仍是默认配音通道 |
| Gemini 4 Carbon | 接替 Opus 的复杂代码审计、竞品证据、经营分析、分镜与经济交叉复核；经 `scripts/gemini-carbon-review.py` 留痕；Opus 当前因地区限制停用 |

除 Kimi 主 Agent 外，模型与子代理不得直接写 Ozon 商品、价格或库存。任何模型输出都要由 Kimi 核验证据、合规、成本与质量。

## 六、代码地图

- `apps/`：`api-services`、`ops-agent`、`promo-agent`、`web-dashboard`。
- `packages/`：`ai`、`cache`、`embedding`、`feishu-bot`、`logger`、`logistics`、`ozon-api-wrapper`、`ozon-order`、`price-monitor`、`scraper`、`shared-types`、`validator`。
- `scripts/`：部署、Direct 报表、模型封装、图片/视频与运营辅助工具。
- `tools/ozon-mcp-server/`：上游前台工具及 ONZO 本地竞品采集接入；上游安装说明不构成调度授权。
- `temp/`：工作产物与历史实验，不是现行架构或 SOP 的权威来源。

## 七、架构文档维护

新会话先读 `AGENTS.md` 和 `docs/current-pipeline.md` 第九节。部署与故障处理分别使用 `docs/deployment.md`、`docs/operations-manual.md`、`docs/troubleshooting.md`。设计目标、历史报告和停用 playbook 必须有明显边界；不得通过添加“当前”字样把旧方案恢复为现行架构。
