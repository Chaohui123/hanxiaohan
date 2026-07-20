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
