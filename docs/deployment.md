# ONZO 部署手册

## Docker 一键部署

```bash
# 1. 克隆项目
git clone <repo-url> && cd Onzo

# 2. 配置环境
cp .env.example .env.production
nano .env.production  # 填入 OZON_CLIENT_IDS, OZON_API_KEYS, KIMI_API_KEY, DEEPSEEK_API_KEY, API_KEY

# 3. 启动生产环境（production=PostgreSQL/Redis/Caddy；standalone 仅用于另列的本地/降级场景）
docker compose --profile production --env-file .env.production up -d

# 4. 验证
curl http://localhost:3000/health
# → {"status":"ok"}

# 5. （可选）n8n 工作流
# 定时任务已由 api-services 内建 scheduler 全覆盖（订单同步/自动发货/死信重试/
# Token 监控/DB 备份/队列上架），正常部署无需 n8n。
# 如需可视化编排可自行启用：docker compose --profile production --profile n8n up -d
# 打开 http://localhost:5678，自行创建/导入工作流（仓库不再随附工作流 JSON）。
# 注意：工作流可通过 $env.ONZO_API_BASE / $env.ONZO_API_KEY 调用 api-services，
#       compose 的 n8n profile 已自动注入；独立部署 n8n 需手动设置这两个环境变量。
```

## 手动部署

```bash
# 要求: Node.js >= 22, pnpm >= 9
pnpm install
cp .env.example .env
pnpm --filter @onzo/api-services dev
```

## 自动部署（deploy-watch，GitHub Actions 不可用时的替代）

服务器 cron 每 5 分钟运行 `scripts/deploy/deploy-watch.sh`：检测 `origin/main` 有新 commit 时自动 `git reset --hard` + `docker compose --profile production up -d --build` + 缓存清理 + 健康检查。日志：`/home/ubuntu/deploy-watch.log`。

```bash
# 手动触发一次
/home/ubuntu/onzo/scripts/deploy/deploy-watch.sh
# 查看部署日志
tail -f /home/ubuntu/deploy-watch.log
```

GitHub Actions 恢复后两者可并存（同一套 reset+compose 动作，幂等）。

### 注意：Caddy 单文件 bind mount 与 git reset 冲突

当前 Compose 实际以单文件 bind mount 挂载 `docker/caddy/Caddyfile`；`deploy/Caddyfile` 仅为补充模板，修改入口前须以实际挂载为准。`git reset --hard` 重建文件后 **inode 变更**，容器内挂载点仍指向旧 inode，导致 Caddy 配置失效（表现为域名 502/无响应）。deploy-watch 已内置 `docker restart onzo-caddy` 兜底；**手动在服务器执行 git 操作后必须同样重启**：

```bash
docker restart onzo-caddy
```

同理：不要在 deploy-watch 构建期间并行手动 `docker compose build`，并发构建会损坏 buildkit 缓存（已发生两次），需 `docker builder prune` 恢复。

## 环境变量完整清单

```ini
# === Ozon API ===
OZON_CLIENT_IDS=5140601
OZON_API_KEYS=fcc5c1dc-xxxx-xxxx-xxxx-xxxxxxxxxxxx
OZON_API_BASE=https://api-seller.ozon.ru

# === AI 模型 ===
KIMI_API_KEY=sk-xxxx
KIMI_BASE_URL=https://api.kimi.com/coding/v1
KIMI_VISION_MODEL=kimi-k3

GLM_API_KEY=key_xxxx
GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4

DEEPSEEK_API_KEY=sk-xxxx
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
DEEPSEEK_FLASH_MODEL=deepseek-v4-flash
DEEPSEEK_PRO_MODEL=deepseek-v4-pro

# === production（必填 PostgreSQL/Redis） ===
DATABASE_URL=postgresql://onzo:<受控密码>@postgres:5432/onzo_prod
REDIS_URL=redis://:<受控密码>@redis:6379
REDIS_PASSWORD=<受控密码>
LLM_DAILY_TOKEN_LIMIT=500000
MAX_AI_CONCURRENCY=10
API_SERVICE_PORT=3000
ENV=production

# === standalone（仅本地/降级，不得用于当前生产） ===
SQLITE_DB_PATH=./data/onzo.db

# === 爬虫 ===
SCRAPER_MAX_BROWSER_POOL=3
SCRAPER_REQUEST_DELAY_MIN=800
SCRAPER_REQUEST_DELAY_MAX=1500

# === n8n ===
N8N_USER=admin
N8N_PASSWORD=CHANGE_ME_STRONG_PASSWORD
N8N_ENCRYPTION_KEY=change_me_to_random_32_chars
```

## 健康检查

| 端点 | 用途 |
|---|---|
| GET /health | 存活检测 |
| GET /ready | 就绪检测 (含 DB) |
| GET /api/dashboard | 运营指标 |

## 数据备份

```bash
# 手动备份（API 内建，pg_dump→gzip；配置 ENCRYPTION_KEY 时再加密为 .enc）
curl -X POST -H "X-API-Key: $API_KEY" http://localhost:3000/api/db/backup
# → API 容器 /app/data/backups/onzo-<timestamp>.sql.gz[.enc]，由 app_data 卷持久化

# 自动备份由 api-services 默认每 6 小时执行，正常部署不依赖 n8n；
# 保留期、加密和恢复演练见 operations-manual.md 6.2–6.3。
```

## 日志

```bash
# 开发模式: 控制台输出
# 生产模式: Pino JSON 日志 (可重定向到文件)
docker compose logs -f api-services
```

## GitHub 账号迁移（2026-10-25 状态留档，后续以最新回读为准）

> 本节记录当时的迁移与注册受限状态，不代表今日仍在等待或需要重复注册；执行前必须重新核对账号、远端和最新部署回执。

- 当前生产远端仍为 `git@github.com:Chaohui123/hanxiaohan.git`，旧仓库、旧 CI/Deployments 记录、生产数据库、数据卷和 `.env.production` 均保留，未清空可用部署。
- 完整镜像在 `temp/git-migration-20261025/hanxiaohan-mirror.git`：`main=c744aa86`、5322 个对象、`git fsck --no-dangling` 通过；`temp/git-migration-20261025/working-tree.patch` 和 `staged.patch` 保存未提交修改，禁止混入其他 tracked 变更。
- 本机迁移提交 `41cd1f7d` 已固定 `pnpm@11.9.0`，Docker/GHCR 权限仅为 `contents: read`、`packages: write`。`pnpm install --frozen-lockfile`、`pnpm run build`、`pnpm test` 已通过：71 个测试文件、610 项测试全部成功。
- GitHub 官网、API 和 GHCR 已通过独立住宅路由访问，但三个住宅出口的注册页均出现 DataDome「访问暂时受限」，直连则被重置。已通过官方 `cannot_sign_in` 流程验证邮箱并提交注册受限工单（含截图）；查看工单需登录，禁止重复提交。当前等待官方注册支持答复，**不得据此提前切换生产远端**。
- 详细检查点见 `temp/git-migration-20261025/status.json`。后续顺序：验证新 GitHub 账号 → 创建并校验新仓库 → 新 CI 全绿 → 保留 `legacy` 并切换 `origin` → deploy-watch 部署 → 核验 `/health`、`/ready`、关键 checks 和实际 commit。若新 CI 或部署失败，不切换或回滚到 `c744aa86`，不删除数据卷。
