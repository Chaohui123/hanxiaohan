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

Caddy 配置文件是单文件 bind mount。服务器执行会替换文件 inode 的 Git 操作后，容器可能仍引用旧 inode，需执行：

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
