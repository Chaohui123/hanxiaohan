# ONZO 生产运维手册 v2.0

> 适用基线：2026-10-24 之后的 Docker Compose production 部署。
>
> 服务器项目目录：`/home/ubuntu/onzo`；生产配置：`/home/ubuntu/onzo/.env.production`。
>
> 生产数据以 PostgreSQL 为主，Redis 用于缓存与调度协调；**不是 `/root/onzo` 下的 SQLite + tsx 裸机部署**。
>
> 本文只记录仓库已有的部署、接口和排障方式；凭据只从受控环境读取，不写入文档、命令历史或日志。

---

## 一、生产架构与操作红线

### 1.1 核心服务

| Compose 服务 | 容器名 | 职责 |
|---|---|---|
| `api-services` | `onzo-api` | API、内建定时任务、健康检查、备份与业务数据访问 |
| `postgres` | `onzo-postgres` | PostgreSQL 16 + pgvector，业务主库 |
| `redis` | `onzo-redis` | 缓存、分布式锁与调度协调 |
| `promo-agent` | `onzo-promo-agent` | 推广汇报、竞品监控与 decision-engine |
| `ops-agent` | `onzo-ops-agent` | 运营机器人与 API 内部调用 |
| `caddy` | `onzo-caddy` | 80/443 入口、HTTPS 与反向代理 |

`production` profile 还包含 `onzo-web-dashboard` 和 `onzo-whisper`；排障时以实际 `docker compose ps` 为准，不要把它们与上述六个核心容器混淆。

持久化数据主要由 Compose named volumes 保存：`postgres_data`、`redis_data`、`app_data`、`app_logs`、`app_dead_letter`、`promo_data`、`caddy_data` 等。**不要通过删除容器或卷来“清理故障”**，尤其不要对数据卷执行 prune。

### 1.2 订单与价格写操作红线

- 自动订单、价格相关写操作只能由 `apps/promo-agent/src/decision-engine.ts` 对应的 **decision-engine** 链路执行，不得另开脚本、第二个定价引擎或人工绕过审计直接写入。
- **当前整改期（2026-10-24）`PROMO_AUTO_DECISION=false`。** 不得通过 dashboard 的 `on`、直接调用内部 `/auto-decision`，或修改容器环境来临时开启。
- 整改期可以查看只读看板、日志和历史记录；不得以“手动触发一轮”为名执行价格动作。
- 恢复自动决策前必须完成专项审计并获明确确认：至少覆盖 decision-engine 写路径、astra-guard、防重复/幅度/频率限制、底价与成本映射、促销价口径、失败处理及 `promo_audit_log` / `promo_pricing_history` 可追溯性。审计通过前保持 `false`；恢复后先核对下一轮计划与实际写结果，不能只确认进程启动。

### 1.3 通用排障原则

1. 先读状态与日志，再重启；先定位单个服务，不要默认 `docker compose down` 全栈。
2. 区分“进程活着”“依赖就绪”“业务数据正确”：容器 Up、`/health`、`/ready` 和业务看板要分别验证。
3. 不用重启掩盖限流、凭据失效、数据错误或磁盘满；修复根因后再恢复任务。
4. 不盲目删除死信、备份、数据库文件或 Docker 卷；先留快照并确认保留策略。
5. 不在 deploy-watch 构建期间并行手动构建，不在服务器工作树保留未交接的手工改动。

---

## 二、日常巡检与健康检查

以下命令均在服务器 `/home/ubuntu/onzo` 执行：

```bash
cd /home/ubuntu/onzo

docker compose --profile production --env-file .env.production ps

curl -sS http://localhost:3000/health
curl -sS http://localhost:3000/ready

free -h
df -h
ss -tlnp | grep -E ':(80|443|3000)\b'
```

### 2.1 `/health` 与 `/ready` 的判断口径

| 检查 | 覆盖内容 | 注意事项 |
|---|---|---|
| `GET /health` | API 存活及数据库、DeepSeek、Chromium、两个 agent 的摘要 | 实现会在部分故障时仍返回 HTTP 200；必须检查 JSON 的 `status`、`dbConnected`、`opsAgentRunning`、`promoAgentRunning` 和 `details`，不能只用 `curl -f` 判定业务健康 |
| `GET /ready` | DB、Ozon API、Redis、备份/数据目录磁盘、模型密钥配置 | 关键依赖失败时返回 503；逐项查看 `checks`。Redis 当前被代码视为可选依赖，但 production 仍应运行并排查其异常 |
| `GET /health/light` | 轻量进程与 DB 检查 | 用于需要较低开销的检查，不代替完整 `/ready` |

容器健康状态也不是业务正确性的证明。发布、重启或故障恢复后，还要读取真实运营看板并检查相关日志。

### 2.2 真实运营看板

```bash
curl -sS -H "X-API-Key: $API_KEY" \
  "http://localhost:3000/api/promo/operations-board?days=30"
```

- 这是当前真实看板接口，支持 `days=1`、`7`、`30`，默认 30 天；不是硬编码演示数据。
- 重点读取 `period`、`totals`、`items[].warnings` 和 `sourceStatus`。`sourceStatus` 分别反映 analytics、products、price、stock、cost 数据源状态。
- `orderedRevenueRub` 是**下单口径收入，不是实际结算回款**；接口不估算净利润，不能把它当回款或利润。
- 必需上游数据源失败会返回 502，并保留来源状态；此时先修复数据源，不要把空 `items` 解读为“零订单/零流量”。
- `$API_KEY` 指服务器受控环境中已有的 API 密钥；不要把实际值贴进终端记录或工单。

---

## 三、启动、重启与配置变更

### 3.1 标准启动与单服务恢复

```bash
cd /home/ubuntu/onzo

# production 全栈启动/对齐 Compose 配置
docker compose --profile production --env-file .env.production up -d

# 仅重建并替换 API（需要应用新镜像时）
docker compose --profile production --env-file .env.production up -d --build api-services

# 仅重启某个现有容器，不重建镜像
docker compose --profile production --env-file .env.production restart api-services

docker compose --profile production --env-file .env.production ps
curl -sS http://localhost:3000/health
curl -sS http://localhost:3000/ready
```

- `restart` 只重启进程，不会重新读取 `.env.production` 并重建容器配置；修改环境变量后使用对应的 `up -d` 让 Compose 重建受影响服务。
- API 重建后如 agent 出现 `ECONNREFUSED`，重启 `onzo-promo-agent` 与 `onzo-ops-agent` 以重建连接；deploy-watch 已包含这一动作。
- 不把 `pkill`、`nohup npx tsx`、`/tmp/onzo.log` 或 crontab 拉起 tsx 作为生产恢复手段。生产进程由 Docker 的 `restart: always` 和 Compose 管理。

### 3.2 Caddy 与 502

Caddy 配置文件是单文件 bind mount，当前 Compose 实际挂载 `docker/caddy/Caddyfile`（`deploy/Caddyfile` 仅为补充模板）。服务器执行会替换文件 inode 的 Git 操作后，容器可能仍引用旧 inode，需执行：

```bash
docker restart onzo-caddy
docker logs --tail 100 onzo-caddy
```

若日志出现 upstream 解析或连接失败，继续检查 `onzo-api` 是否存在、是否健康及 `/ready`；不要只反复重启 Caddy。若端口无响应，同时核对 80/443 监听和宿主机防火墙。

---

## 四、deploy-watch 自动部署

服务器 cron 每 5 分钟执行 `scripts/deploy/deploy-watch.sh`。脚本检测到 `origin/main` 变化后执行：fetch、`git reset --hard origin/main`、production Compose 构建、Caddy/agent 重启、构建缓存限额清理和 `/health` 检查。

```bash
# 手动触发一次既有脚本
/home/ubuntu/onzo/scripts/deploy/deploy-watch.sh

# 查看部署日志
tail -n 100 /home/ubuntu/deploy-watch.log
tail -f /home/ubuntu/deploy-watch.log
```

部署后必须人工核对：

```bash
cd /home/ubuntu/onzo
docker compose --profile production --env-file .env.production ps
curl -sS http://localhost:3000/health
curl -sS http://localhost:3000/ready
docker compose --profile production --env-file .env.production logs --tail 100 api-services
```

注意：

- 脚本在构建成功前已推进 Git HEAD；若构建失败，下一轮可能因 `HEAD == origin/main` 而跳过。**Git 已是最新不等于部署成功**，需按日志手动重跑既有 production Compose 构建并完成健康验收。
- `/health` 门禁存在“HTTP 200 但 JSON degraded”的盲区，因此必须补看 `/ready` 和响应内容。
- 不要在 deploy-watch 运行期间并行 `docker compose build`，以免损坏 BuildKit 缓存。磁盘/缓存异常先查 `df -h` 和部署日志，不要直接全量 prune 数据卷。
- 手动 Git 操作后重启 Caddy；API 重建导致 agent 连接失效时重启两个 agent。

---

## 五、日志与资源排障

### 5.1 容器日志

```bash
cd /home/ubuntu/onzo

docker compose --profile production --env-file .env.production logs --tail 100 api-services
docker compose --profile production --env-file .env.production logs --tail 100 postgres
docker compose --profile production --env-file .env.production logs --tail 100 redis
docker compose --profile production --env-file .env.production logs --tail 100 promo-agent
docker compose --profile production --env-file .env.production logs --tail 100 ops-agent
docker compose --profile production --env-file .env.production logs --tail 100 caddy

# 持续跟踪单个服务
docker compose --profile production --env-file .env.production logs -f --tail 100 api-services
```

生产日志由 Docker `json-file` driver 管理；核心服务已配置单文件 20 MB、最多 5 个文件的轮转。不要再找 `/tmp/onzo.log`。应用挂载日志位于 `app_logs` 卷，业务备份位于 `app_data` 卷；不要用宿主机旧路径推断容器内文件。

排障日志应保留 correlation ID、任务 ID、HTTP 状态和原始错误内容。只记录“errors: 1”而没有错误内容时，应继续取对应服务日志，不能据此判断根因。

### 5.2 常见系统问题

- **磁盘满**：先看 `df -h`、deploy-watch 日志和 Docker 占用；优先按既有备份保留期、日志轮转和 deploy-watch 的构建缓存策略处理。禁止用 `docker system prune --volumes` 或删除数据库卷清空间。
- **内存不足/频繁重启**：用 `free -h`、容器状态和对应日志确认 OOM 或崩溃，再按 Compose 资源限制定位；不要只增加重启频率。
- **端口冲突**：用 `ss -tlnp` 确认 80/443/3000 的占用者，再决定停哪个重复服务；不要杀不明进程。

---

## 六、PostgreSQL、Redis 与备份

### 6.1 数据库与缓存检查

```bash
docker exec onzo-postgres psql -U onzo -d onzo_prod -c "SELECT 1"
docker compose --profile production --env-file .env.production logs --tail 100 postgres
docker compose --profile production --env-file .env.production logs --tail 100 redis
curl -sS http://localhost:3000/ready
```

- 生产故障不要再按 `SQLITE_BUSY`、SQLite 单写锁、`VACUUM INTO` 或复制 `onzo.db` 处理。
- PostgreSQL 锁/超时问题应结合 API 日志、`pg_stat_activity` 和具体 SQL 排查；不要直接杀数据库进程或删除 `postgres_data`。
- Redis 异常会影响缓存和调度协调。检查容器、日志和 `/ready`，恢复后确认定时任务是否继续执行，不能只确认 PING。

### 6.2 自动与手动备份

API 内建备份启动约 60 秒后首跑，之后默认每 6 小时执行，默认保留 7 天；实际以 `BACKUP_INTERVAL_HOURS`、`BACKUP_RETENTION_DAYS` 和 `BACKUP_DIR` 的生产配置为准。主路径是 PostgreSQL `pg_dump` → gzip；生产配置 `ENCRYPTION_KEY` 后使用 AES-256-GCM 加密，最终文件名为：

```text
onzo-<UTC时间戳>.sql.gz.enc
```

备份默认写入 API 容器 `/app/data/backups`，由 `app_data` 卷持久化，**不是** `/root/onzo/data/backups`，也不是 SQLite `.db` 文件。

```bash
# 手动触发既有备份接口
curl -sS -X POST -H "X-API-Key: $API_KEY" \
  http://localhost:3000/api/db/backup

# 通过 API 查看备份清单和保留天数
curl -sS -H "X-API-Key: $API_KEY" \
  http://localhost:3000/api/db/backups

# 从容器视角核对文件
docker exec onzo-api ls -lh /app/data/backups

# 核对备份执行日志
docker logs --tail 200 onzo-api
```

验收不能只看“接口返回成功”：还要确认新 `.sql.gz.enc` 文件、大小、时间和 `[Backup] Created` 日志。若出现未加密 `.sql.gz`，先核对 `ENCRYPTION_KEY` 是否有效配置并排查原因，不要把明文备份异地分发。远程上传只有在既有 `RCLONE_REMOTE` 与 rclone 实际可用时才算成功；本地生成文件不等于异地副本已验证。

### 6.3 恢复边界

`.sql.gz.enc` 是带认证标签的加密备份，**不能直接 `gunzip` 后导入 psql**。恢复属于独立的高风险操作：先在隔离环境用对应受控密钥完成解密和恢复演练，核对 schema、关键表与行数；生产恢复前必须停止写入、保留现状快照并明确空库/清理策略。当前手册不提供未经验证的一键解密或倒灌命令，禁止把加密文件直接覆盖、拼接或导入正在使用的数据库。

---

## 七、外部服务与业务故障

### 7.1 Ozon API：401 与 429

**401 Unauthorized**：

1. 查 `/ready` 的 `ozonApi` 和 `onzo-api` 日志，区分凭据缺失、过期与权限问题。
2. 在 Ozon 卖家后台核对 API 密钥状态；需要轮换时只更新服务器 `.env.production` 中对应值，不在命令行打印密钥。
3. 用 Compose `up -d` 重建受影响服务，再查 `/ready` 和业务接口；不要改本地 `.env` 充当生产修复。

**429 Rate Limit / 熔断**：

1. 从 `onzo-api` 日志确认触发接口、时间和熔断器状态，降低并发或暂停非必要调用，等待限流与熔断探测恢复。
2. 重启不是首选解法，也不能提高 Ozon 配额；只有确认代码/连接状态异常时才按单服务流程重启。
3. 对可重试任务，在根因恢复后使用既有死信重试机制，并观察是否再次限流，避免 tight loop。

### 7.2 图片拉取、COS 与死信

图片导入失败仍按三类原因排查：

- 1688 等来源的 Referer/防盗链导致 Ozon 无法下载；
- SVG、超小图或非标准格式不被接受；
- `localhost`、内网地址或错误路由对 Ozon 不可见。

处理原则：给 Ozon 可公开访问的 HTTPS 图片 URL，或走已配置的 COS 公网地址；用实际图片响应而不是浏览器能否打开来验证。若经 Caddy 暴露图片，还要确认返回的是图片而不是 SPA 的 HTML。

COS 失败时检查 `onzo-api` 日志、COS 配置、Bucket 权限/区域/额度，再使用既有死信重试接口。死信位于 `app_dead_letter` 卷；不要执行旧的 `rm -rf /root/onzo/dead-letter/*`，删除前必须确认已备份且无需重试。

### 7.3 LLM、翻译与汇率

- **Token 达限**：读取 `GET /api/stats/llm` 和 API 日志，确认是真实业务增长、prompt 过长还是并发过高。限额由 `LLM_DAILY_TOKEN_LIMIT` 控制；不要为了消警无审计追加重复环境变量。确需调整时编辑 `.env.production` 并用 Compose 重建受影响服务。
- **DeepSeek/Kimi 401、429、5xx 或 timeout**：分别判断密钥、额度/并发、上游故障和网络。先看 `/health`、`/ready` 与日志，不在排障输出中暴露完整密钥；429 先降并发/退避，5xx 保留重试与降级，不能反复重启刷请求。
- **类目匹配失败**：保留自动 retry、程序化类目树搜索和错误记录；查看具体 pipeline 返回的 `errors`，不要以 `categoryId: 0` 直接写库。
- **汇率异常**：读取 `GET /api/stores/fx`。`stale: true` 先查缓存更新和汇率源网络；`reliable: false` 时尊重上架阻断，不能手填一个未经验证的汇率绕过。

上述受保护 API 使用 `X-API-Key: $API_KEY`；不要在未鉴权反复返回 401 时误判为业务接口失效。

---

## 八、快速诊断与路径索引

### 8.1 最小诊断集

```bash
cd /home/ubuntu/onzo

docker compose --profile production --env-file .env.production ps
curl -sS http://localhost:3000/health
curl -sS http://localhost:3000/ready
curl -sS -H "X-API-Key: $API_KEY" \
  "http://localhost:3000/api/promo/operations-board?days=30"
curl -sS -H "X-API-Key: $API_KEY" \
  http://localhost:3000/api/db/backups

df -h
free -h
uptime
tail -n 100 /home/ubuntu/deploy-watch.log
```

诊断信息外发前脱敏：密钥、token、买家地址/电话、完整 webhook、数据库连接串均不得贴入日志或聊天。

### 8.2 路径对照

| 内容 | 当前位置 |
|---|---|
| 服务器仓库 | `/home/ubuntu/onzo` |
| 生产环境文件 | `/home/ubuntu/onzo/.env.production` |
| deploy-watch 脚本 | `/home/ubuntu/onzo/scripts/deploy/deploy-watch.sh` |
| deploy-watch 日志 | `/home/ubuntu/deploy-watch.log` |
| PostgreSQL 数据 | Compose `postgres_data` 卷 |
| API 备份目录 | 容器 `/app/data/backups`，Compose `app_data` 卷 |
| API 应用日志目录 | 容器 `/app/logs`，Compose `app_logs` 卷 |
| 死信目录 | 容器 `/app/dead-letter`，Compose `app_dead_letter` 卷 |
| promo-agent 决策状态 | 容器 `/app/data`，Compose `promo_data` 卷 |
| 容器运行日志 | `docker compose logs` / `docker logs`，非 `/tmp/onzo.log` |

### 8.3 常用只读端点

| 端点 | 用途 |
|---|---|
| `GET /health` | 综合存活摘要；必须读 JSON，不只看 HTTP 200 |
| `GET /ready` | DB/Ozon/Redis/磁盘/密钥就绪检查 |
| `GET /api/promo/operations-board?days=30` | 30 天真实运营看板及来源状态 |
| `GET /api/promo/decision` | 查看 promo-agent 可达性、自动决策开关与最近计划；整改期应保持自动决策关闭 |
| `GET /api/db/backups` | 备份清单与保留天数 |
| `GET /api/stats/llm` | Token 使用与限额排障 |
| `GET /api/stores/fx` | 汇率新鲜度与可靠性 |


---

## 九、Ozon 搜索查询采集与 7/28 天分析（2026-11-09 本机降级实证）

### 9.1 当前边界

- 免费官方 `/v1/search-queries/top`、`/v1/search-queries/text` 实测要求 Premium Pro；原生“下载”弹出订阅窗口，未获得 XLSX/CSV 或免费定时投递。不得擅自开通会员。
- 服务器及已验证 Google Cloud 区域的标准 Chromium 访问 Seller 页面均返回 403。MPSTATS 官方 API 是外部市场热度和竞争补充，不具备 Seller 原生加购转化、独立买家及订单转化等完整字段，不能替代本报表。
- 用户已允许降级为本机 Chrome 只读提取。真实接口为 `POST /api/site/searchteam/Stats/queries/search/v2`，通过正常翻页取得当次会话请求头；不导出 Cookie、CSRF 或敏感请求头，不绕过验证码、MFA、风控或会员限制。该私有接口没有官方 SLA，字段或权限变化时必须停止并重新验收。
- Seller 页面需激活标签页才加载。采集器通过 `data-selected="true"` 与 `disabled` 判断当前页，点击另一页取得真实请求，不能把后台未加载或筛选空态当成真实零数据。
- 搜索查询是 Ozon **市场分析**，不是本店 SKU 曝光、订单或独立买家漏斗。`ord` 映射“下单独立买家”，`itemsViews` 映射“展示商品数量”，`uniqSellers` 映射“竞争对手”；接口原始 `avgCountItems` 未在当前页面展示，不作语义猜测。

### 9.2 采集、发布与原始证据

```bash
# 本机 Chrome 登录有效、WebBridge 已连接时执行；先验证单页
node tools/ozon-search-analytics/src/local-collector.mjs --max-pages=1 --output=data/search-analytics

# 完整批次：只有全部页面、总数、去重与哈希一致才生成 COLLECTED 清单
node tools/ozon-search-analytics/src/local-collector.mjs --output=data/search-analytics

# 再次验证完整文件，不触发上传
node tools/ozon-search-analytics/src/publish-run.mjs <run-directory> --verify-only

# 环境变量由受控用户环境提供；不得打印真实密钥
node tools/ozon-search-analytics/src/publish-run.mjs <run-directory>
```

本地原始文件位于 `data/search-analytics/runs/<runId>/`，包含逐页脱敏请求、原始 JSON、服务端时间、SHA-256 与 manifest。服务端 ingest 再次校验完整批次，将原始文件保存到 `/app/data/search-analytics/raw/<runId>/`，数据库保存其索引和哈希。生产密钥仅放在权限 600 的 `data/secrets/search-analytics.env`，Compose 以可选 `env_file` 加载；不读写现有 `.env.production`，不把密钥提交到仓库或传给其他模型。

接口为 `POST /api/search-analytics/ingest`，使用 gzip 和独立 `X-Search-Ingest-Key`。普通 dashboard 查询仍走原认证；独立 ingest 路径不使用 Seller API 主密钥代替。失败尝试可以单独登记，不能发布半成品或覆盖最近成功批次。

### 9.3 查询、趋势、导出与派生窗口

- `GET /api/search-analytics/queries?window=7|28&query=&page=&pageSize=&sort=&direction=`
- `GET /api/search-analytics/queries/trend?query=<原始查询词>&days=90`
- `GET /api/search-analytics/runs`、`GET /api/search-analytics/metrics`
- `GET /api/search-analytics/export?window=7|28&format=csv|xlsx&query=`
- 前端 `/search-analytics` 提供原生 7 天、积累中的 28 天、历史趋势、采集健康和 CSV/XLSX 下载。

每日滚动 7 天重叠 6 天，不能直接相加。28 天只使用四个不重叠的原生 `days_7` 快照；锚点来自各页服务端时间，接口未返回自然日边界或时区，因此派生结果不能冒充官方自然日 28 天。首周只有 7/28 覆盖，缺周时停止派生，不把缺席查询补 0。独立买家不去重求和；均价、竞争、份额和未确认分子分母的转化率不盲目平均。动态 28/7 保持 `NULL`，年度趋势当前为空数组；28 天本身不能证明季节性。

### 9.4 Windows 每日任务与故障处理

任务脚本为 `tools/ozon-search-analytics/run-local.ps1`，注册脚本为 `register-local-task.ps1`。预定每天 **13:47（本机本地时间）** 执行，使用当前用户交互会话、单实例锁和一小时超时。只有生产 API、独立密钥和本机 Chrome 登录态均验收后才可注册并启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/ozon-search-analytics/register-local-task.ps1
Start-ScheduledTask -TaskName "ONZO Ozon Search Analytics"
Get-ScheduledTaskInfo -TaskName "ONZO Ozon Search Analytics"
```

用户环境必须提供 `SEARCH_ANALYTICS_API_URL`、`SEARCH_ANALYTICS_INGEST_KEY` 和授权店铺的数字公司ID `SEARCH_ANALYTICS_COMPANY_ID`。登录失效、扩展断开、403、验证码、窗口或店铺不一致、漏页、重复页、哈希不符均停止并非零退出；旧成功数据保留，`last-attempt` 与 `last-success` 分开，服务端发出 `SEARCH_ANALYTICS_FAILED` 告警。不能把脚本启动或 HTTP 200 当作整批成功，也不承诺本机无人值守云端采集。

### 9.5 已完成的隔离验收

真实批次 `2026-11-09T04-10-23-926Z` 共 199 页、9,942 条，内容 SHA-256 为 `ee29ab5653863691c0ffc93f1794d0bf0a3b761662923b17853b9cdceb8892e5`。完整 ingest、末页逐条回读、关键词筛选、原生趋势、CSV/XLSX、幂等导入、原始回执索引及 React 页面已通过。证据在该运行目录的 `local-api-validation.json` 与 `ui-validation.json`（运行数据目录已 ignored）。

```bash
node --import tsx tools/ozon-search-analytics/test/smoke-search.mjs <complete-run-directory>
node --test tools/ozon-search-analytics/test/local-collector.test.mjs
pnpm exec vitest run apps/api-services/tests/search-analytics.test.ts apps/api-services/tests/search-analytics-init.test.ts
```

以上是本机采集和隔离 API/页面验收，不等于生产 PostgreSQL、正式域名或 Windows 定时任务已经上线；这些状态以 `docs/current-pipeline.md` 第九节最新回读为准。


### 9.6 生产部署与定时任务验收（2026-11-09）

- 经用户明确授权，提交 `955c6b3b`、`18d1b077` 已推送到 `origin/main` 并由 deploy-watch 部署。新 API 启动 smoke 和 `/ready` 全部通过，`PROMO_AUTO_DECISION=false` 未改。
- 正式入口为 `https://huashangshangmao.top/search-analytics`。生产实际挂载 `docker/caddy/Caddyfile`，其现有 SPA 回退已支持 React 页面；`deploy/Caddyfile` 仅是补充模板。原 nip.io 地址不是当前证书域名，不能用它替代当前实际域名。
- 正式 HTTPS ingest 将 199 页、9,942 条写入 PostgreSQL，重复导入 `idempotent=true`。逐页原始响应哈希、每行 `metrics_json` 与 `raw_row_sha256` 全部一致，动态 28/7 为 NULL。生产 API 的首页、末页、趋势、运行健康、CSV/XLSX 均已回读通过，证据 `temp/ops-exec/search-production-validation-20261109.json`。
- 正式 React 页面已用现有登录态验收，显示 199/199 页、9,942 条和原始首行；自建 28 天页明确显示当前 7/28 覆盖和缺周原因。截图 `temp/ozon-search-production-20261109.png`。
- Windows 任务 `ONZO Ozon Search Analytics` 已注册为每日 13:47（当前用户交互会话）。首次实跑于 2026-11-09 14:24 启动，`LastTaskResult=0`，发布 `2026-11-09T06-24-05-227Z`，下一次回读为 2026-11-10 13:47。直接复跑 `2026-11-09T06-29-08-976Z` 也成功，最新成功证据 `data/search-analytics/last-success.json` 和 `temp/ops-exec/search-windows-task-first-run-20261109.json`。
- `run-local.ps1` 已修正 Node 中文输出的 UTF-8 读取与日志写入；旧 UTF-16 日志已转换为 UTF-8，历史乱码不重造。任务日志为 `data/search-analytics/scheduled.log`。
- 独立密钥仅存在于本机用户环境和服务器权限 600 的 `data/secrets/search-analytics.env`，未读取或改写原 `.env.production`，未进入 Git、日志或前端。部署前数据库备份为 `/home/ubuntu/onzo/scripts/data/backups/onzo-pre-deploy-20261109-084448.sql.gz`，回滚镜像标签为 `onzo-api-services:rollback-search-analytics-20261109` 和 `onzo-web-dashboard:rollback-search-analytics-20261109`。
- 以上是首次部署、首次调度与直接复跑证据，不承诺连续多日无人值守。采集仍依赖本机 Chrome 登录态和前台标签页；登录失效、风控或页面结构变化必须停止告警，不自动改通道。28 天仍需四个不重叠周窗口，当前不伪造完整 28 天或季节性。


补充验收：提交 `16547752` 已同步到生产，`/ready` 通过。知识条目 `pb_ozon_search_query_local_fallback_20261109` 已按同 ID 更新为生产与定时任务实证，`persisted=true`，远端和本机正常检索命中第一；回执 `temp/ops-exec/ozon-search-query-knowledge-production-result-20261109.log`，替换前备份在服务端 `knowledge-before-ozon-search-query-production-20261109.json`。定时 `knowledge-janitor` 清理的是低质条目，当前生产实证已回读确认保留。


### 9.7 失效标签页恢复与 UTF-8 日志（2026-11-10 实证）

- 2026-11-10 13:47 定时任务 `ONZO Ozon Search Analytics` 首次次日执行失败，错误为 `extension_error: No tab with given id 203942741`。失败运行 `2026-11-10T05-47-04-748Z` 已上报，旧成功数据未覆盖，不能把该错误当作真实零查询。
- 原因是上次任务页已关闭而会话仍引用旧 ID。`local-collector.mjs` 每轮先 `close_session` 清理本采集器自己创建的任务页，再新建并激活 Seller 页面，不再复用旧 ID。借用用户页面不由 `close_session` 关闭，不能为了修复而清理用户其他标签页。
- 原生请求上下文通过当前 `data-selected/disabled` 页码、另一可用页按钮和真实指针翻页取得；不猜接口参数，不绕过会员、验证码或风控。成功后清理任务页；失败时保留本次任务页供核查，下一轮仍先清理旧会话。
- 日志由 `run-local.mjs` 使用 Node 直接追加 UTF-8；PowerShell 只负责启动和传递退出码。若旧日志含混合编码或 NUL 字节，先重命名为带时间戳的 `.legacy` 文件保留原始证据，再建立新 UTF-8 日志，不重造历史文本。可用 `node tools/ozon-search-analytics/src/run-local.mjs --log-self-test` 单独检查日志，不产生业务批次。
- 修复后通过真实 Windows 定时任务完整执行并发布 `2026-11-10T15-02-05-470Z`：199 页、9,945 条，`LastTaskResult=0`，下一次回读为 **2026-11-11 13:47**。生产 PostgreSQL、原始回执、逐行哈希、API、趋势与 CSV/XLSX 全部通过；正式页面不再显示“最近一次采集失败：extension_error”。
- 工具测试 6 项通过，PowerShell 语法检查通过。证据：`temp/ops-exec/search-tab-recovery-task-20261110.json`、`temp/ops-exec/search-tab-recovery-production-validation-20261110.json`、`data/search-analytics/last-success.json`、`data/search-analytics/scheduled.log`。商品价格、库存、广告及 `PROMO_AUTO_DECISION=false` 未因此改变。

### 9.8 登录会话恢复与错账户发布闸门（2026-11-11）

- 当任务停在“Вход и регистрация”时，先保留失败运行与旧成功数据，不要把登录页当成查询为0。使用本机真实Chrome重新打开并激活 `https://seller.ozon.ru/app/analytics/what-to-sell/all-queries`；必须看到本店ТехноМир和真实表格，才可补采。不要注册新账户、选择不明账户或绕过验证码/MFA。
- 正式补采继续使用 `Start-ScheduledTask -TaskName "ONZO Ozon Search Analytics"`，并同时回读 `LastTaskResult=0`、`data/search-analytics/last-attempt.json`、`last-success.json`、生产 `/api/search-analytics/runs` 与正式页面。本次运行 `2026-11-11T14-38-14-659Z` 为199页、9,948条，公司5140601，内容SHA-256为 `20c12aa2050290ca1aa27d9ada83c8695311c5ce339d6146fa43185bc6e45dce`。
- `SEARCH_ANALYTICS_COMPANY_ID` 现在是正式任务必填的用户环境变量，当前授权公司为 `5140601`。采集器只在正常翻页取得原生请求上下文后核对 `x-o3-company-id`；不符时报 `SELLER_WRONG_ACCOUNT`，未配置或不是数字公司ID时报 `SELLER_ACCOUNT_UNVERIFIED`，两种情况都不得上传。`run-local.ps1` 会在启动时拒绝缺失或无效配置。
- 可用隔离目录验证闸门，不发布样本、不改变正式成功状态：
  ```powershell
  $env:SEARCH_ANALYTICS_COMPANY_ID=[Environment]::GetEnvironmentVariable("SEARCH_ANALYTICS_COMPANY_ID", "User")
  node tools/ozon-search-analytics/src/local-collector.mjs --max-pages=1 --output=temp/ops-exec/search-login-recovery-20261111/account-guard-sample
  ```
  本次正确公司样本为1页50行、`SAMPLE_VALIDATED`；将进程内预期公司临时设为9999999作反向测试时，实际5140601被明确拒绝且没有上传。不要把该预期值写回用户环境。
- 全量生产回读已用50个API页面逐行对照9,948条 `rawMetrics` 与原始回执；趋势、CSV/XLSX通过，页面显示新runId、199/199页、9,948行和SHA-256，失败告警消失。证据目录 `temp/ops-exec/search-login-recovery-20261111/`，终验 `production-validation.json`，正式页面截图 `dashboard.png`，正反闸门证据在各自 `runs/` 清单。自建28天仍为7/28、`insufficient_history`，相邻滚动周不相加。
- 工具8项、全项目81文件786项测试、build及PowerShell语法通过。知识条目 `pb_ozon_search_account_guard_20261111` 已通过正式门禁，精确回读一致，服务器与本机检索均命中第一；回执 `knowledge-gate-result.log`，替换前备份在服务器 `/app/data/backups/knowledge-before-search-account-guard-20261111.json`。经营数据、商品价格、库存、Direct及 `PROMO_AUTO_DECISION=false` 未改。

### 9.9 Ozon 账户选择验证自动处理（2026-11-11）

- 遇到“Вход и регистрация”时，采集器不再只等待表格：先定位可见且启用的“Войти/登录/选择账户”等明确登录控件，以真实指针点击一次；随后从账户候选中选择 `SEARCH_ANALYTICS_ACCOUNT_LABEL` 指定的店铺，默认 `ТехноМир`。`run-local.ps1` 会传递该可选用户环境变量。
- 没有店名时，只在页面明确显示账户选择且候选唯一的情况下尝试该候选；有多个不明候选报 `SELLER_ACCOUNT_CHOICE_REQUIRED`，绝不逐个尝试。出现验证码或人工校验报 `SELLER_AUTH_INTERACTION_REQUIRED`，点击后超时仍无表格报 `SELLER_ACCOUNT_SIGN_IN_TIMEOUT`。注册、手机验证码、Cookie导出和绕过风控均不属于自动流程。
- 到表格不代表结束：仍须正常翻页取得原生请求上下文，并由 `assertExpectedCompany` 核对 `x-o3-company-id=5140601`，才能继续采集与发布。本地清单的 `accountSelection.loginButtonUsed/accountChoiceUsed` 记录本轮是否实际点击，不把等待恢复写成点击成功。
- 验证证据：`fixture-validation.json` 是本地仿真DOM在真实Chrome中依次点击login→account:ТехноМир的通过回执，不是Ozon真实登录页；`live-sample/runs/2026-11-11T15-18-20-232Z-sample/manifest.json` 是当前有效Ozon会话的一页50行回归，两个动作均为false、公司正确、未上传。当前真实账户选择页未复现，下一次自然出现时必须回读动作标记与公司ID；不得为制造测试而退出登录。
- 工具12项、全项目81文件786项测试、build及PowerShell语法通过。证据目录 `temp/ops-exec/search-account-choice-20261111/`。定时任务保持每日13:47，样本不改正式last-success或经营数据。

---

## 十、跨会话每周经营复盘（2026-11-11 实证）

### 10.1 调度边界

服务器每周一 **03:28 UTC** 只读生成 `/home/ubuntu/onzo/data/weekly-reviews/latest.json`。本机 Windows 任务 **`ONZO Weekly Review`** 每周一 **14:41（本地时间）** 以当前用户 S4U 执行 `scripts/run-weekly-review.ps1`，不再依赖 Kimi 会话或会话 Cron。2026-11-11 系统任务实跑成功后，旧会话任务 `01M735EZ33KK15Q9E5ATQHNG75` 已删除，不再按旧 Cron 补建或双跑。

该任务仍依赖本机开机、已有模型授权及所需代理服务，不是云端无人值守承诺；不得把本机 OAuth、模型密钥或 Chrome 登录态复制到服务器。自 2026-11-13 起，Astra、Gemini 4 Carbon、Argon 与 Kimi API 的实际模型、档位和用量以各次回执为准，失败不得以其他模型冒充；Opus 因地区限制退出当前调度。任务只读，不改 Ozon 商品、价格、库存、促销、Direct、广告或评价。

```powershell
# 注册或恢复正常周任务（不带恢复目录）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/register-weekly-review-task.ps1

Get-ScheduledTask -TaskName "ONZO Weekly Review"
Get-ScheduledTaskInfo -TaskName "ONZO Weekly Review"

# 手动开始一轮全新复盘；不使用 --resume
Start-ScheduledTask -TaskName "ONZO Weekly Review"
```

### 10.2 文件、锁与失败语义

- `scripts/weekly-review-core.mjs` 负责输入校验、原子写入和单实例锁；PowerShell 另有本机互斥锁。不要强行删除仍属活跃进程的 `runner.lock`。
- 每轮原始输入、共享提示词、各模型回执、Kimi 原文和报告保存在 `data/weekly-reviews/runs/<runId>/`。Kimi 返回后先保存 `rawContent`、实际模型和 usage，再解析 JSON；格式无效写 `INVALID_INTEGRATION_JSON`，不修补成虚构报告。
- 根目录 `last-run.json` 是最近一次尝试，`latest-review.json` 是最近发布的结构校验通过报告，`last-success.json` 是其指针与哈希。这里的 success 可包含已声明的模型或数据缺口，不代表全部模型成功或数据新鲜。
- 失败发出 `WEEKLY_REVIEW_FAILED`，保留上一份成功报告；不得用旧报告冒充本轮完成。系统任务 `LastTaskResult=0` 还必须与 `last-run.json`、runId、完成时间和报告内容交叉回读。
- 共享提示词通过 `--competitor-last-run` 显式绑定冻结目录的 `competitor-last-run.json`。除独立回执存在外，还校验最老直接可比快照、完成时间、未来时间、过滤/子集、失败计数和待对账项；失败计数不是“回执不存在”。

### 10.3 只恢复最终整合

```bash
node --import tsx scripts/weekly-review-runner.mjs --resume data/weekly-reviews/runs/<existing-runId>
```

`--resume` 只接受当前存储 `runs` 下的已有目录，复用原始输入、提示词及已保存的模型文件，不重新抓取输入，也不调用 Astra、Carbon 或 Argon。缺失的 Astra 原文标 `ASTRA_RAW_OUTPUT_MISSING`，已有失败回执不自动重试；只允许重新执行 Kimi 最终整合。自 2026-11-13 起新运行使用 `carbon.json`，旧 `opus.json` 只按历史 Opus 证据恢复，不改名或冒充 Carbon。`scripts/run-weekly-review.ps1 -Resume <目录>` 是相同能力的系统包装。若临时给系统任务添加恢复参数，完成后必须立即还原为不带 `-Resume` 的正常动作，防止下周重复处理旧目录。

### 10.4 本次恢复验收与检查

首次任务 `weekly-2026-11-10T17-01-04-268Z` 曾因 Kimi JSON 解析失败而退出 1；当时未保存原始响应，不能事后断定是截断。修复后由真实 Windows 任务恢复同一目录，2026-11-11 01:16:29 启动，`LastTaskResult=0`，最终状态 `COMPLETED_WITH_DECLARED_GAPS`，报告 SHA-256 为 `aae57e44833955834199a6be481065b1645b043835f39844118d764eb32d8eb8`。正常任务下一次触发为 **2026-11-16 14:41**，动作中不含 `--resume`。

本次 Argon 原文与哈希复用成功，实际档位未返回；Opus 因地区资格失败且 0 token，Astra 原始文本缺失。源快照超过 36 小时，竞品存在 7 条直接可比抓取失败与 1 条直接可比缺必填，不能称为全量健康或当前最新经营数据。报告中的最多 3 项行动均为待办，不表示已执行。

```bash
pnpm exec vitest run apps/api-services/tests/weekly-review-core.test.ts
python -m unittest scripts.test_weekly_report_validation
pnpm test
pnpm build
pnpm lint
```

本机与文档修改前备份位于 `data/backups/weekly-review-cross-session-20261111/`。知识更新必须走正式 `knowledgeGate + persistToPlaybook`，不得手写 SQL 绕过。

### 10.5 Astra 运行时与 Opus 代理排查（2026-11-11 实证）

- S4U 不继承当前 Git Bash 会话额外注入的 PATH。首次 Astra 原文缺失的直接环境原因是裸 `bash` 解析失败：同 S4U 探针返回 `spawnSync bash ENOENT`，没有启动 Codex。证据 `temp/ops-exec/weekly-astra-s4u-path-probe-20261111.json`。
- `astraAdapter` 现使用 `C:\Program Files\Git\bin\bash.exe`，可通过 `GIT_BASH_PATH` 指定其他已验证路径。每轮将命令、prompt SHA-256、stdout、stderr、退出码和错误写入 `astra-process.json`；只有退出码 0 且 stdout 非空才生成 `astra.txt`。非零退出时的部分 stdout 只留在进程证据中，不能当成成功评审。实际模型、档位和 session ID 从本次 CLI 回执提取，不回读不到就保持未知。
- 2026-11-11 正式任务 `weekly-2026-11-10T17-44-16-950Z` 已在 S4U 下完成真实 Astra 评审：`gpt-6-astra/high`、进程退出码 0、中文原文与报告 SHA-256 一致。任务退出码 0，stderr 为空；报告为 `COMPLETED_WITH_DECLARED_GAPS`，不是全量模型或当前数据健康证明。
- Opus 代理对照必须保持相同提示词、模型、档位和沙箱。`ProxyEnable=0` 与临时开启为 1 时均返回同一地区资格错误、0 turns、0 tokens；10808 显式代理出口实测为美国。因此不能把失败简单归因为未开系统代理，也不能从该错误进一步推断具体账户封禁、节点信誉或地区库原因。对照回执 `temp/ops-exec/opus-proxy-system-off-20261111.json`、`opus-proxy-system-on-20261111.json`。
- 诊断后已恢复 `ProxyEnable=0`。不得为了消除该错误擅自切换账号、伪造地区、绕过资格限制或用 Terra 冒充 Opus；后续只能依据新的服务侧资格回执复核。本轮专项测试 11 项、全项目 785 项通过，构建通过，Lint 0 errors/215 个既有 warnings。
- 本轮文档修改前备份位于 `data/backups/weekly-review-adapter-fix-20261111/`。旧恢复目录的 Astra 缺失仍作为历史事实保留；修复后的新证据在 `data/weekly-reviews/runs/weekly-2026-11-10T17-44-16-950Z/`。

### 10.6 Gemini 4 Carbon Direct 规划与长输出恢复（2026-11-11 实证）

完整全店推广方案位于 `temp/direct-carbon-20261111/plan.md`，模型原始续写回执为 `carbon-continued.json`，Kimi审核结构化版本为 `plan-reviewed.json`，19品额度/预算/身份校验为 `validation.json`。这些文件是分析和未授权草案，不是广告创建、启动或实际利润回执。

```bash
# 普通同步调用；先保存原文、实际模型和usage，再解析JSON
python scripts/gemini-carbon-plan.py --prompt <prompt.txt> --output <result.json>

# 长任务异步：保存真实operation；轮询中断后用同一operation恢复，不新建批次
python scripts/gemini-carbon-batch-plan.py --prompt <prompt.txt> --output <batch.json>
python scripts/gemini-carbon-batch-plan.py --prompt <prompt.txt> --output <batch.json> --operation <existing-operation>

# 从已有operation或续写state恢复；contents必须与原prompt完全一致
python scripts/gemini-carbon-continue.py --prompt <prompt.txt> --operation-file <operation.json> --output <continued.json>
python scripts/gemini-carbon-continue.py --prompt <prompt.txt> --resume-state <continuation-state.json> --output <continued.json>
```

- 实际模型须为 `gemini-4-carbon`，请求HIGH不能冒充实际档位已回读。原始正文、实际模型、分段usage和状态分开保存，不用其他模型冒充。
- `MAX_TOKENS` 或空正文不是成功方案。异步返回可能把 `inlinedResponses` 放在 `operation.response` 下，需按真实回执解析；续写token只在受控本地状态与原始证据保存，不在报告中展示。
- 本次API明确返回累计 `max_output_tokens` 已耗尽时，可在同一续写令牌上提高累计额度并保留state；不要从头重新生成。续写最终必须达到可验证的结束状态，JSON与19品身份、利润和预算约束再次校验。
- Carbon给出的季节性、旺季/淡季和需求推断必须由Kimi降级为待证假设；目标CPA不是实际CPA或已结算利润。所有新计划保持 `DRAFT_NOT_AUTHORIZED`，不得因模型输出自动创建、启动、改价或扩预算。
- 本次33X14草案为3.5美元目标CPA、35美元周计划额度，仍缺具体写入授权、当前余额、广告法现状、Ozon集成、前台可售与审核回读；实际创建/启动均为0。现有715426752仅有待审批停损建议，未暂停。
- Direct普通API当前仍不支持本店marketplace campaign管理；不得调用普通Campaigns.add伪造创建。生产创建须使用既有合规界面或正式支持通道，并逐项回读商品、地区、CPA、预算、归因与审核状态。
- 本轮文档修改前备份为 `data/backups/direct-carbon-plan-20261111/`；全项目785项测试通过，未改生产商品、价格、库存、广告或评价。以下是方案生成时状态；用户随后明确授权执行，实际结果见10.7。

### 10.7 Direct 实际执行与多 campaign 监测（2026-11-11）

- 用户明确要求“按照完整方案逐步执行”并继续创建，授权范围仅为方案中的存量停损与33X14候选，不是任意扩品或追加预算。实际执行结果 `temp/direct-carbon-20261111/execution/execution-result.json`。
- 现有 `715426752` 已停止，未设置定时恢复。读取状态变化、重新打开及列表“已停止”均留证；不得仅点击按钮就宣称完成。
- 新campaign `716088179` 仅含 `GEN-BELT-33X14-01` / SKU `5900476661`，俄罗斯、自动受众、购买目标、CPA 3.5美元、周预算35美元、预算自动上浮关闭，既有Ozon Performance连接已回读。默认周预算5000美元与默认预算上浮4%均已显式纠正，不点击“全部推广”。
- 地区自定义组件必须最终出现 `RegionsTreeTagGroup.tag.*.name=俄罗斯`，仅输入文字或DOM存在弹窗都不算成功；弹窗是否可见须看 computed visibility，不以元素是否存在判断。保存草稿后重新打开该ID，确认CPA/预算/地区等仍正确；启动后曾显示审核中，最新详情已变为活跃且审核中提示消失，不将此表述为订单或收入保证。
- 买家前台已实际打开候选商品，本店、SKU、参数、购买入口、1671₽/1761₽银行渠道展示价与配送预估均已留证；银行价不等于卖家收入，配送时效是转化风险，不隐瞒。
- 日报默认监测 `715426752,716088179`，可通过 `YANDEX_DIRECT_CAMPAIGN_IDS` 显式覆盖。`byCampaign` 按campaign分别计算，旧顶层窗口仅为主campaign兼容字段。`hasReportRows=false` 只表示当前无报表行，不能证明审核、投放或未来转化为0。
- 正式任务 `ONZO Direct Daily Report` 于2026-11-11 15:14实跑返回0，下一次11-12 11:20；此前0x800710E0无对应脚本/API错误记录，原因不伪造。周复盘任务仍在11-16 14:41执行，不新建重复调度。
- 7天或5单先到复盘，后续调整需重新核利润、真实CPA、库存和授权，不自动启停、不自动加预算。最新监测与启动不代表已出单或盈利。全项目786项测试、build通过，Lint 0 errors/215既有warnings。修改前备份为 `data/backups/direct-plan-execution-20261111/`。

### 10.8 Gemini 4 Carbon 接替 Opus（2026-11-13）

- Opus 因持续地区资格限制退出当前工作流。复杂跨文件审计、竞品证据、经营分析、分镜与经济交叉复核改由 Carbon；Hydrogen 仍负责日常代码、桌面任务分析和视觉理解，Astra、Argon、Luna 的既有职责不变。不自动重试 Opus、换区或把其他模型输出改名为 Opus。
- 通用审查使用 `python scripts/gemini-carbon-review.py --prompt-file <文件> --output <JSON>`。执行器固定 `gemini-4-carbon`，保存 prompt SHA-256、实际模型、正文、finishReason 和 usage；仅实际模型一致、STOP 且过滤 thought 后正文非空才 SUCCESS。请求 HIGH 但 `actualThinkingLevel` 未返回时保持 NULL；MAX_TOKENS、空正文、HTTP/网络/密钥错误均保留脱敏失败回执，不换模或自动续写。
- 周复盘第二席由 Opus 改为 Carbon，实际执行为 `python scripts/gemini-carbon-review.py --prompt-file <冻结prompt> --output <runDir>/carbon.json`。新运行先原子保存 `model-route.json`，标明第二席 Carbon 和精确模型；正式报告顺序为 Astra/Carbon/Gemini/Kimi。不得只凭系统任务返回0就宣称替换成功，必须回读 Carbon 证据与最终报告。
- 恢复历史运行时，无新路由标记的目录继续读取旧 `opus.json`，保留 seat、旧模型、错误和字段；新路由目录读取并严格校验 `carbon.json`。新旧证据不得混名，失败/缺失分别保留 `CARBON_EXECUTION_FAILED`、`CARBON_EVIDENCE_INVALID`、`CARBON_RAW_OUTPUT_MISSING`。
- 本次独立 Carbon 元数据与真实审查回执位于 `temp/ops-exec/carbon-replaces-opus-20261113/`：元数据为 `models/gemini-4-carbon`、支持 generateContent；最小真实审查返回 `CARBON_REVIEW_OK`，实际模型一致、STOP、268 total tokens，实际 HIGH 未返回。离线9项、周复盘专项17项、全项目81文件792项测试及build通过，独立复核无阻塞问题。
- 正式 `ONZO Weekly Review` 已实跑 `weekly-2026-11-13T04-21-59-082Z`：12:21:58启动、12:27:53完成，`LastTaskResult=0`；Astra、Carbon、Argon、Kimi均SUCCESS。Carbon实际模型正确、STOP、正文9892字符、76,558 total tokens，报告SHA-256为 `1a0952e8202c31f4332f947fdd5cc972b08810a15ef88361c1103585e0211bec`。报告状态为 `COMPLETED_WITH_DECLARED_GAPS`，经营快照96.9小时且竞品存在runId不一致、fatal、陈旧直接快照与采集失败；这不是当前经营健康证明，未自动执行任何建议。下一次仍为11-16 14:41，未新增重复任务。综合校验 `routing-validation.json`，原始报告在对应运行目录。


---

## 十一、Yandex Cloud AI、SpeechKit 与 Search API（2026-11-14）

### 11.1 当前账户、权限与密钥边界

- `account-dione-3300`（`dn2pvzztpuqdyephhjlx`）已回读为 **Active / Paid version**，关联 1 个云。现有 `cloud-584001555qqcom` / `default` 文件夹（`b1g7kg5sf3nob759onuo`）可用，Cloud Shell 中官方 `yc 1.41.0` 已实跑，不需要重建云、文件夹或 Billing。
- 服务账号 `onzo-yandex-api`（`ajenm8nu2hhln4p9op2c`）仅有 `ai.speechkit-tts.user`、`ai.speechkit-stt.user`、`ai.translate.user`、`ai.vision.user`、`search-api.webSearch.user` 五项角色，未授予管理员或资源编辑权限。
- 本机服务账号 JSON 位于 `data/secrets/yandex-cloud/service_account_key.json`，该目录已忽略提交，文件权限已收紧；不得读取到聊天、打印日志、写入代码或发送给模型。ONZO 服务器部署时，秘密文件应通过受控秘密交付流程放到 `/home/ubuntu/onzo/data/secrets/yandex-cloud/service_account_key.json` 并设权限 600；`app_data` 卷会映射为容器内 `/app/data/secrets/yandex-cloud/service_account_key.json`。**本次尚未执行秘密上传、Git 提交或 ONZO 生产部署。**
- 共享包为 `packages/yandex-cloud`，使用服务账号 JWT PS256 换取并缓存 IAM token。环境变量：`YANDEX_CLOUD_FOLDER_ID`、`YANDEX_CLOUD_SA_KEY_FILE`、`YANDEX_CLOUD_PROXY_URL`。本机脚本显式使用 `127.0.0.1:10808`，不改变系统代理；生产服务器直连 Yandex IAM 实测超时，Compose 已固定 `YANDEX_CLOUD_PROXY_URL=http://172.28.0.1:10809`（可用环境变量覆盖），使用既有出口，不改系统代理。
- 受控凭据配置入口为 `POST /api/yandex-cloud/credential`，沿用现有 dashboard/API 鉴权。请求必须是当前 `onzo-yandex-api` 的授权 JSON 且包含 `confirmProductionUpload=true`；服务端校验服务账号和字段后，以 600 权限原子写入，响应不回显私钥，不创建明文备份。浏览器文件选择可直接把下载的授权 JSON 提交到该接口，避免经过聊天、Git、命令历史或普通文本日志。后续轮换也走此入口；错误账号在上游写入前拒绝。

### 11.2 SpeechKit 配音与真实验收

正常视频默认改为 SpeechKit API v3 `marina+friendly`，不再默认 Edge。`main.voice` 必须为：

```json
{"provider":"yandex","model":"speechkit-v3","name":"marina","role":"friendly","rate":"+0%"}
```

- 正式编排仍是 `python temp/video-pro-pipeline/run_one.py <video-plan.json>`，生成器为 `temp/video-pro-pipeline/make_vo_yandex.py`。真实请求是 `POST https://tts.api.cloud.yandex.net:443/tts/v3/utteranceSynthesis`，字段为 `text` 与 `hints=[{voice:"marina"},{role:"friendly"}]`，不传速度。
- 每句返回的 Base64 音频块合并成 WAV，校验完整解码、时长和文本/音频 SHA-256 后原子替换；付费请求失败、超时或结果不明不自动重发，不静默切换 Edge、Gemini 或其他音色。
- 本机真实样音为 5.67 秒、22050Hz、mono、16-bit PCM。供应商隐藏盲评使用 Gemini 4 Argon 实际音频输入，结果 **PASS 96 分**；Yandex OggOpus STT 完整还原原句。证据：`temp/ops-exec/yandex-cloud-20261114/marina-blind-review.json`、`pipeline-voice/vo1.wav`、`other-capabilities-result.json`。
- 历史 Edge/Gemini A/B 仅是当时证据，不再决定当前默认。新候选仍需逐句 WAV 与真实音频模型盲评，不能只看 HTTP 200 或文件名。

### 11.3 Wordstat 与网页搜索 API

选品不再默认打开 Wordstat 前台，统一使用：

```bash
node scripts/yandex-wordstat.mjs --phrase "ремень вариатора снегоход" \
  --regions 225 --devices all --limit 50 --output temp/wordstat-result.json

# 可选完整月份趋势、地区分布和购买意图搜索结果
node scripts/yandex-wordstat.mjs --phrase "ремень вариатора снегоход" \
  --period monthly --dynamics-from 2026-01-01 --to-date 2026-10-31 \
  --regions-stats cities --search-intent --output temp/wordstat-full.json
```

后端路由同时挂载到 `/api` 与 `/api/v1`：

- `POST /yandex-cloud/wordstat/top`
- `POST /yandex-cloud/wordstat/dynamics`
- `POST /yandex-cloud/wordstat/regions`
- `POST /yandex-cloud/search`
- `GET /yandex-cloud/status`（只表示密钥文件是否配置，不代替真实 API 验收）

保留原始关键词、操作符、地区、设备、时间窗和回执。关键词总量与关联词不能自动判为目标购买需求；缺失月份保持缺失，不按 0。月度 `fromDate` 必须是月初、`toDate` 必须是月末；周/月趋势只支持 `+`，引号、精确词形、减词和分组使用日趋势。实际回执中 2026 年 10 月未返回，未补造数值。搜索 XML 同时保留并解析为 position/title/url/domain/snippet，供 Kimi 核验购买意图。

### 11.4 Translate、STT、OCR 与其他云能力

- **Translate**：`translateToRussian` 已真实返回俄语，可作商品文案初稿与术语辅助，但本次“水箱”被译为普通容器，证明仍须 Kimi 按商品语境终审，不能自动上线。
- **STT**：同步 v1 使用 OggOpus，**不支持 MP3**；`recognizeRussianOggOpus` 已回读配音原文。`POST /api/yandex-cloud/stt` 接收 `audioOggOpusBase64` 并要求 `confirmNoSensitiveData=true`，解码后不得超过 1 MB。首次音色验收或高风险文案可在 plan 设置 `main.voice.stt_verify=true`，临时 WAV 转 OggOpus 后回读，规范化文本与原文一致才替换正式音轨；默认不逐句计费复核，差异/失败不自动重发。真实回执 `pipeline-voice-stt-verified/vo1.speechkit.json` 为 PASS。供应商语音和售后转写仍须审查隐私并复核文本，不替代真实音频模型盲评。
- **Translate 与辅助接口**：`POST /api/yandex-cloud/translate` 接收 `texts` 与可选 `sourceLanguageCode`，只返回待审草稿，不替代 DeepSeek/Luna/Kimi 终审。`POST /api/yandex-cloud/stt`、`POST /api/yandex-cloud/ocr` 均要求 `confirmNoSensitiveData=true`，缺少确认在调用上游前返回 400；真实三接口验收见 `auxiliary-api-smoke-result.json`。
- **Vision OCR**：`POST /api/yandex-cloud/ocr` 接收 `imageBase64` 与可选 `languages`，要求 `text_detection_config` 并检查业务内层 `error`，不能只凭外层 HTTP 200 判成功。测试图中文、英文和数字均识别，但部分语言标签出现 `hu` 误判，故只按实际文字与业务证据使用，不盲信语言标签。订单、买家、卡号、地址等敏感截图不得上传，未确认不上传，不默认把采购截图交给 OCR。
- Cloud Functions、Object Storage、Lockbox 均只读验证 `access=PASS, count=0`，表示账户可访问且当前没有对应资源，**不代表已经创建或迁移**。后续可评估 Cloud Functions + Scheduler 承载 Wordstat 定时采集、Object Storage 归档原始回执、Lockbox 管理秘密；实施前须另做成本、权限、网络、数据驻留与回滚评审。
- Ozon Seller 原生搜索查询仍受会员与本机浏览器会话限制，Yandex Wordstat 不能替代其加购、独立买家和订单转化指标，也不证明此前云端 Chromium 403 已解决。

### 11.5 部署后必须执行的验收

本次本机已完成真实 TTS、Wordstat Top/月度/地区/网页搜索、Translate、OggOpus STT 和 Vision OCR；全项目 84 文件 807 项测试、视频专项 66 项及 build 通过。提交并经 deploy-watch 部署后，还必须：

1. 在容器内仅检查密钥文件存在与权限，不打印内容；调用 `GET /api/yandex-cloud/status`。
2. 用受控测试词调用真实 `/api/yandex-cloud/wordstat/top`，再生成一条 Marina WAV，回读 HTTP、原始字段、文件格式和音频哈希。
3. 核对日志没有 JWT、IAM token、私钥或完整音频 Base64；失败不回退到 Wordstat 前台或 Edge。
4. 回读 `PROMO_AUTO_DECISION=false`、Ozon 商品价格库存与 Direct 未因此改变。未完成这些步骤前，只能称为本机真实 API 验收，不称为 ONZO 生产服务器已上线。
