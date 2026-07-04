# ONZO 部署手册

## Docker 一键部署

```bash
# 1. 克隆项目
git clone <repo-url> && cd Onzo

# 2. 配置环境
cp .env.example .env
nano .env  # 填入 OZON_CLIENT_IDS, OZON_API_KEYS, GLM_API_KEY, DEEPSEEK_API_KEY

# 3. 启动
docker compose up -d

# 4. 验证
curl http://localhost:3000/health
# → {"status":"ok"}

# 5. 导入 n8n 工作流
# 打开 http://localhost:5678
# 逐个导入 n8n/workflows/*.json
# 以下工作流需要手动激活（Scheduled 类型导入后默认 active）：
#   ✅ auto-publish.json      — 每 10 分钟自动上架队列商品
#   ✅ auto-retry-notify.json  — 每 30 分钟重试失败任务 + Telegram 报告
#   ✅ auto-ship.json         — 每 3 小时自动发货待处理订单
#   ✅ order-sync.json        — 每 30 分钟同步 Ozon 订单
#   ✅ price-monitor.json     — 每日竞品价格扫描
#   ✅ token-monitor.json     — 每 6 小时 Token 消耗报告 + DB 备份
#   ⬜ phase-1-listing.json   — Webhook 触发（手动/外部系统调用）
#   ⬜ multi-store-publish.json — 手动触发（多店铺批量上架）
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
GLM_API_KEY=key_xxxx
GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
GLM_VISION_MODEL=glm-4.6v-flash

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
N8N_PASSWORD=onzo2026
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
