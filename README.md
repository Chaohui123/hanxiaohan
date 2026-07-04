# ONZO — Ozon 跨境电商 AI 自动化系统

1688 无货源 → Ozon 自动上架 + 订单履约 + 多店铺管理

## 快速启动

```bash
# 1. 安装依赖
pnpm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env 填入 Ozon/GLM/DeepSeek 密钥

# 3. 启动服务
pnpm --filter @onzo/api-services dev
# → http://localhost:3000
# → 运营看板: http://localhost:3000/
# → API 文档: http://localhost:3000/api/docs

# 4. Docker 部署
docker compose up -d
# → n8n: http://localhost:5678
# → api: http://localhost:3000
```

## 环境变量

| 变量 | 说明 | 必填 |
|---|---|---|
| OZON_CLIENT_IDS | Ozon Client-ID | ✅ |
| OZON_API_KEYS | Ozon API Key | ✅ |
| GLM_API_KEY | 智谱 API Key (OCR) | ✅ |
| DEEPSEEK_API_KEY | DeepSeek API Key (翻译) | ✅ |
| LLM_DAILY_TOKEN_LIMIT | 单日 Token 上限 | - |
| ENV | `dev` Mock / `production` 真实 | - |

## 核心功能

### P0 商品上架
```bash
# 手动 JSON 上架
curl -X POST http://localhost:3000/api/process/manual \
  -H "Content-Type: application/json" \
  -d '{"title":"蓝牙音箱","priceCny":25,"specImages":["https://..."],"specifications":[{"name":"颜色","value":"黑色"}]}'

# 1688 URL 自动上架
curl -X POST http://localhost:3000/api/process/sync \
  -H "Content-Type: application/json" \
  -d '{"url":"https://detail.1688.com/offer/xxxx.html"}'

# 批量导入 (JSON/CSV/Excel)
curl -X POST http://localhost:3000/api/bulk/import/csv \
  -H "Content-Type: application/json" \
  -d '{"csvText":"title,price,images\nProduct,25,https://..."}'
```

### P1 订单履约
```bash
# 同步订单
curl -X POST http://localhost:3000/api/orders/sync

# 标记发货
curl -X POST http://localhost:3000/api/orders/ship \
  -d '{"postingNumber":"xxx","trackingNumber":"TRACK123","products":[{"sku":123,"quantity":1}]}'
```

### P2 比价选品
```bash
# 入库竞品价格
curl -X POST http://localhost:3000/api/price/scan \
  -d '{"prices":[{"platform":"ozon","productSku":"SKU1","priceRub":999,"url":"https://..."}]}'

# 竞争力评分
curl -X POST http://localhost:3000/api/price/score \
  -d '{"ourPriceRub":800,"competitorPrices":[{"priceRub":1000,"platform":"ozon"}]}'
```

### 多店铺管理
```bash
# 添加店铺
curl -X POST http://localhost:3000/api/stores \
  -d '{"storeId":"shop1","clientId":"111","apiKey":"k1","storeName":"Shop A","groupName":"group-a"}'

# 绑定代理
curl -X POST http://localhost:3000/api/stores/shop1/proxy \
  -d '{"proxyUrl":"http://proxy.example.com:8080"}'

# 跨店批量同步
curl -X POST http://localhost:3000/api/stores/batch/sync-orders \
  -d '{"groupName":"group-a"}'

# 全局汇总
curl http://localhost:3000/api/stores/summary
```

## 技术栈

| 层 | 技术 |
|---|---|
| 语言 | TypeScript (Node.js 22+) |
| 框架 | Express 4 |
| 数据库 | SQLite (node:sqlite + Drizzle ORM) |
| 爬虫 | Playwright |
| AI | GLM-4.6V (OCR) + DeepSeek-V4 (文本) |
| 工作流 | n8n |
| 部署 | Docker + docker-compose |
| 包管理 | pnpm monorepo |

## 项目结构

```
packages/
  ai/              → @onzo/glm-integration     GLM + DeepSeek 统一封装
  logger/          → @onzo/logger              结构化日志
  ozon-api-wrapper/→ @onzo/ozon-api-wrapper    Ozon API SDK (限流/熔断)
  ozon-order/      → @onzo/ozon-order          订单同步 + 库存 + Webhook
  price-monitor/   → @onzo/price-monitor       竞品比价 + 选品评分
  scraper/         → @onzo/scraper-1688        1688 Playwright 爬虫
  shared-types/    → @onzo/shared-types        全局类型定义
  validator/       → @onzo/validation-layer    上架前置校验
apps/api-services/  → @onzo/api-services        Express 统一接口服务
n8n/workflows/                                 8 条自动化工作流
```

> **注意**：三个包的目录名与 npm 包名不同，import 时使用右侧 `@onzo/*` 名称。

## License

MIT
