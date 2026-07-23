# ONZO 部署手册

## Docker 一键部署

```bash
# 1. 克隆项目
git clone <repo-url> && cd Onzo

# 2. 配置环境
cp .env.example .env.production
nano .env.production  # 填入 OZON_CLIENT_IDS, OZON_API_KEYS, KIMI_API_KEY, DEEPSEEK_API_KEY, API_KEY

# 3. 启动（compose 所有服务都带 profile，必须显式指定；standalone=SQLite 单机，production=含 PG/Redis/Caddy）
docker compose --profile standalone --env-file .env.production up -d

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

`deploy/Caddyfile` 以单文件 bind mount 挂进容器。`git reset --hard` 重建文件后 **inode 变更**，容器内挂载点仍指向旧 inode，导致 Caddy 配置失效（表现为域名 502/无响应）。deploy-watch 已内置 `docker restart onzo-caddy` 兜底；**手动在服务器执行 git 操作后必须同样重启**：

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

# === 运营配置 ===
LLM_DAILY_TOKEN_LIMIT=500000
MAX_AI_CONCURRENCY=10
SQLITE_DB_PATH=./data/onzo.db
API_SERVICE_PORT=3000
ENV=production

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
# 手动备份
curl -X POST http://localhost:3000/api/db/backup
# → 备份到 ./data/backups/onzo-2026-07-03T....db

# 自动备份 (n8n token-monitor 工作流每 6 小时执行)
```

## 日志

```bash
# 开发模式: 控制台输出
# 生产模式: Pino JSON 日志 (可重定向到文件)
docker compose logs -f api-services
```
