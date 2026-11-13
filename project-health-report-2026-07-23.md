# ONZO 项目全景健康扫描报告（2026-07-23 历史留档）

> **历史边界**：这是 2026-07-23 的只读扫描快照，不是当前健康报告或待办清单。其中的测试数量、风险状态、凭据处置、架构描述和修复建议只代表当时；不得据此直接删除文件、轮换凭据或修改生产。当前规则见 `AGENTS.md`，当前状态见 `docs/current-pipeline.md` 第九节，工程结构见 `README.md` 与 `docs/architecture.md`。
> 扫描时间：2026-07-23 · 扫描方式：只读静态分析 + 测试实跑 · 范围：D:\Onzo 全仓

---

## 一、项目全貌

**ONZO** — Ozon 跨境电商 AI 自动化系统（1688 无货源 → Ozon 自动上架 + 订单履约 + 多店铺管理）。

实际规模比 README 描述的大不少：

| 维度 | README 口径 | 实际 |
|---|---|---|
| packages/ | 8 个包 | **12 个包**（多出 cache、embedding、feishu-bot、logistics） |
| apps/ | 1 个（api-services） | **4 个**（+ ops-agent、promo-agent、web-dashboard） |
| API 端点 | P0/P1/P2 示例 | 45 个路由文件、约 200+ 端点 |
| 数据库 | SQLite | 双轨：SQLite + PostgreSQL(pgvector)，生产已上 PG |
| 工作流 | n8n | n8n 已可选化，定时任务由内建 scheduler 全覆盖 |

**依赖关系**：干净的 DAG，无循环依赖。双根：`shared-types`（被 8 个包依赖）和 `logger`（被 4 个包依赖）。api-services 汇聚全部 11 个内部包；ops-agent / promo-agent 依赖 embedding、feishu-bot、logger、shared-types。

**质量盘面**：48 个测试文件、376 个用例，**实跑全部通过（2.73s，0 失败）**；TODO/FIXME 标记 0 处；无大段注释死代码；`any` 约 35 处集中在 4 个文件，数量可控。

---

## 二、🔴 高危问题（建议立即处理）

### H1. temp/ 目录明文硬编码生产服务器 SSH 密码，且未被 gitignore

- `temp/` 下 11 个 Python 运维脚本（server-setup.py、diag-docker-data.py、diag-web.py、final-verify.py、migrate-containerd.py、migrate-docker.py、rebuild-web.py、run-migration.py、server-deploy.py、server-probe.py、server-status.py、smoke-cos.py）明文硬编码了生产服务器 IP + 用户名 + SSH 密码。
- **关键风险**：`temp/` 既未跟踪也未被 .gitignore 排除——一次 `git add .` 就会把生产密码提交进仓库。密码目前尚未出现在任何已跟踪文件中，还来得及。
- **处置建议**：把 `temp/` 加入 .gitignore（或删除/外移脚本），并**轮换该服务器 SSH 密码**（密码已出现在多个本地文件中，应按泄露对待）。

### H2. scripts/upload-images.mjs 硬编码真实 API_KEY，已进入 git 历史

- 该脚本内含硬编码的真实 API_KEY 和生产域名 `huashangshangmao.top`，且文件已被 git 跟踪——密钥已进入版本历史。
- **处置建议**：轮换该 API_KEY，改为从环境变量读取，历史中清理（或至少确保今后不再泄露）。

---

## 三、🟡 中危问题

### M1. Lint 工具链断裂
`.eslintrc.json` / `.prettierrc` / `pnpm lint` script 都在，但 eslint、prettier、@typescript-eslint **均未安装**（devDependencies 缺失）。`pnpm lint` 实际跑不起来，质量门禁形同虚设。CI（ci.yml）里的 lint 步骤同样受影响。

### M2. 测试无进程隔离，副作用真实发生
- pipeline-e2e 等测试 import app 时触发 `index.ts` 副作用：注册 13 个真实定时任务、开 WebSocket、跑启动冒烟测试，测试间状态互相污染（死信队列计数跨测试残留）。
- 测试期 `db_write` 冒烟检查报 SQLite 方言错误（`near "(": syntax error`）并真实打开熔断器。
- 反复出现 `cache.counterIncr is not a function` → OzonRateLimiter 在 Redis 不可用时 fail-open 直接放行，这是降级路径上的真实 bug 信号，值得单独排查。

### M3. tsconfig references 与 package.json 依赖漂移
- apps/api-services 缺 5 个 references（cache、logger、logistics、ozon-order、price-monitor）；cache/feishu-bot/logistics 各缺 logger 引用；web-dashboard 非 composite 却被根 references 引用——`tsc -b` 严格构建下容易报 TS6306/TS6307 或退化为非增量编译。目前 dist 能建出来，但引用关系脆弱。

### M4. .env.example 与代码严重脱节
- **约 56 个代码在用的变量未在模板声明**，含安全相关的 `CORS_ORIGINS`、`TRUSTED_PROXY_CIDRS`，以及 compose 引用的 `REDIS_URL`、`MANUAL_PAY_MODE`——新人按模板配置会缺功能。
- **约 13 个声明变量疑为死配置**，其中 `BULLMQ_*` 系列与 `docs/webhook-architecture.md` 明确的"禁 Redis/MQ"约束直接冲突，属历史遗留。
- 另：`.env.example` 中 `FREIGHT_ADDRESS` 填的是真实姓名电话地址——示例文件不应含真实个人信息。

### M5. 目录名 ≠ 包名，部署修复脚本存在解析漏洞
- `packages/ai → @onzo/glm-integration`、`scraper → @onzo/scraper-1688`、`validator → @onzo/validation-layer`。
- 源码 import 全部用了正确包名（无问题），但 `scripts/fix-symlinks.sh`（41-59 行）按**目录 basename** 复制包到 `node_modules/@onzo/`，会产生 `@onzo/ai` 等错误目录名；其 case 列表写的目标目录名在 packages/ 下根本不存在，永远不会命中。正常 Docker 构建路径侥幸可用，一旦走"修复"路径即 MODULE_NOT_FOUND。

---

## 四、🟢 低危 / 债项

| 项 | 说明 |
|---|---|
| L1 | `ozon-order` 的 main 指向 `./dist/index.js`，其余 11 个包指向 `./src/index.ts`——开发态 tsx watch 对 ozon-order 的修改不热生效；main 字段策略全仓不统一 |
| L2 | 零测试覆盖：embedding（核心链路）、feishu-bot、logistics、cache、web-dashboard |
| L3 | drizzle/ 目录全空，drizzle-kit 迁移流形同虚设；实际靠应用启动时代码内建迁移（37+20 张表）；drizzle-schema.ts（24 张 PG 表）与运行时表双轨不同步 |
| L4 | README 过时：n8n 仍是技术栈表述（实际可选化）、数据库写 SQLite（生产已 PG）、项目结构缺 4 个包 + 3 个 app |
| L5 | 依赖声明位置混乱：api-services 运行时重型依赖（express、bullmq、sharp、socket.io 等）声明在根 package.json 而非 app 自身，且根 dependencies 混入 @types/*；api-services 把 @types/multer 等放在 dependencies |
| L6 | src 内约 55 处 console.log 与 pino logger 混用（另有 ~380 处在 scripts/test 调试脚本，可接受） |
| L7 | extensions/1688-assistant 浏览器扩展游离于 workspace 外，无版本/构建/契约校验，仅靠 HTTP 约定与 1688-callback 路由耦合 |
| L8 | deploy/Caddyfile 硬编码生产 IP（与 setup-server.sh "域名不硬编码" 的注释自相矛盾） |
| L9 | `.gitignore` 残留规则：`packages/ozon-order/tests/sync.integration.test.ts`（文件已不存在） |
| L10 | api-services/services 里混入 Python 文件（kuajingbus-export.py），在 NodeNext composite 构建链之外 |

---

## 五、做得好的地方

- 测试 376 用例全绿，核心包（ozon-api-wrapper、ozon-order、scraper、ai）有覆盖且配了 v8 覆盖率阈值
- 包依赖图是干净 DAG，无循环依赖、无错误包名 import
- 中间件层完备：auth、限流、幂等、熔断、PII 脱敏、关联 ID、优雅停机共 17 个
- CI/CD 四条工作流齐备（ci / staging / deploy / config-update），staging 带容器冒烟
- 监控栈完整：Prometheus + Grafana + Alertmanager + Jaeger + OpenTelemetry 全家桶
- 文档体系在 monorepo 里算好的：架构、部署、运维手册、故障排查、webhook 架构共 10 篇
- 数据库 schema 覆盖面广：listing、订单、库存、促销、RAG、对账等 30+ 张表

---

## 六、处置优先级建议

| 优先级 | 动作 | 预估工作量 |
|---|---|---|
| P0 | temp/ 入 gitignore + 轮换服务器 SSH 密码；轮换 upload-images.mjs 的 API_KEY 并改读环境变量 | 半小时 |
| P1 | 补齐 eslint/prettier 依赖让 lint 可用；修复 fix-symlinks.sh 的包名映射 | 1-2 小时 |
| P2 | 补齐 tsconfig references；修复 OzonRateLimiter 的 counterIncr bug；.env.example 同步（补 56 删 13、移除真实个人信息） | 半天 |
| P3 | 测试隔离改造（app 入口副作用与可测试性分离）；embedding/logistics 补基础测试 | 1-2 天 |
| P4 | README 更新、main 字段统一、drizzle 迁移流要么启用要么删除 | 半天 |
