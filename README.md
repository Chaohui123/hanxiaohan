# ONZO — Ozon 跨境电商运营自动化系统

1688 货源核验 → Ozon 上架与履约 → 竞品/价格/广告复盘。系统是辅助运营工具，不以自动化名义绕过商品、利润、合规或生产权限闸门。

> **新会话入口**：先读 [AGENTS.md](AGENTS.md)、[当前工作状态](docs/current-pipeline.md) 第九节并检索知识库。本文只介绍工程与启动方式；运营决策不得从历史设计、旧计划或 `temp/` 调研记录直接执行。

## 当前架构

- **运行环境**：Node.js 22+、TypeScript、pnpm monorepo；当前包管理器锁定为 pnpm 11.9.0。
- **服务**：Express API、React/Vite 看板、ops-agent、promo-agent、Whisper 转录服务。
- **生产数据**：PostgreSQL 16 + pgvector、Redis 7；RAG 当前使用 `vector(1024)`。
- **部署**：Docker Compose + Caddy；定时任务由 api-services 内建 scheduler 执行，n8n 仅为可选可视化编排。
- **本地/降级**：standalone 可使用 SQLite，但不代表当前生产架构，也不得据此处理生产故障。
- **媒体工具**：现有 Python 脚本用于图像、视频、配音和转录；主业务服务仍为 TypeScript/Node.js。

## 本地开发

```bash
pnpm install
cp .env.example .env
# 在 .env 中配置开发/测试环境，不提交密钥，不指向未经授权的生产写入。
pnpm dev:api
```

本地检查：

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

生产部署使用 PostgreSQL、Redis 和 Caddy，不要用 standalone 代替：

```bash
cp .env.example .env.production
# 按 docs/deployment.md 配置受控生产环境。
docker compose --profile production --env-file .env.production up -d
```

完整部署、备份和恢复要求见 [部署手册](docs/deployment.md) 与 [运维手册](docs/operations-manual.md)。不要在日常运维中使用 `docker compose down -v` 或全量清理镜像/数据卷。

## 常用验证命令

```bash
pnpm test
pnpm build
pnpm lint
```

交付前还要验证用户实际场景；仅有导入成功、编译成功或测试通过，不能代替生产回读。

## 项目结构

```text
apps/
  api-services/       Express API、数据库、RAG、scheduler、业务路由
  ops-agent/          运维巡检与通知
  promo-agent/        选品、定价、竞品与推广分析
  web-dashboard/      React/Vite 运营看板
packages/
  ai/                 模型调用封装
  cache/              Redis/缓存抽象
  embedding/          向量生成
  feishu-bot/         飞书机器人能力
  logger/             结构化日志
  logistics/          物流服务
  ozon-api-wrapper/   Ozon API 鉴权、限流、重试与熔断
  ozon-order/         订单同步、Webhook 与库存工具
  price-monitor/      价格监测
  scraper/            1688 采集工具
  shared-types/       共享类型
  validator/          上架前校验
scripts/              运营、部署、报表与媒体辅助脚本
tools/                第三方工具及 ONZO 本地接入边界
temp/                 工作产物、历史调研和实验脚本；不是现行规则来源
docs/                 现行 SOP、运维文档及明确标注的历史/设计资料
```

目录名不必然等于 npm 包名，引用时以各目录 `package.json` 为准。

## 文档分工

- [AGENTS.md](AGENTS.md)：用户规则、模型分工、生产红线与维护机制。
- [现行技术架构](docs/architecture.md)：当前服务、数据流和技术边界。
- [当前链路状态](docs/current-pipeline.md)：实际运行记录与第九节交接快照。
- [Agent SOP](docs/agent-sop.md)：选品、内容、上架与验收流程。
- [故障排查](docs/troubleshooting.md)：按当前 Docker/PostgreSQL/Redis 架构排障。
- [知识库规范](docs/rag-mandatory-reference.md)：RAG 查询、写回、门禁和维护。

历史报告保留其事实证据，但其中的待办、价格、库存、模型路由和“当前状态”只在标注日期有效。
