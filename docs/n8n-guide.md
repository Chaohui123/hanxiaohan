# n8n 工作流导入指南

## 导入步骤

1. 打开 n8n: `http://localhost:5678`
2. 登录 (默认: `admin` / `onzo2026`)
3. 点击右上角 **Import from File**
4. 选择 `n8n/workflows/` 中的 JSON 文件
5. 点击 **Activate** 激活

## 工作流说明

| 文件 | 触发 | 功能 |
|---|---|---|
| `phase-1-listing.json` | Webhook 手动 | 1688 URL → Ozon 草稿 |
| `auto-publish.json` | 定时 10min + 手动 | 自动上架 + 队列监控 |
| `order-sync.json` | 定时 30min | 拉取 Ozon 订单 → 本地存储 |
| `token-monitor.json` | 定时 6h | Token 统计 + DB 备份 |
| `price-monitor.json` | 定时 24h | 竞品价格扫描 |
| `multi-store-publish.json` | 手动 | 跨店铺批量铺货 |

## 配置注意

- n8n 默认通过 `host.docker.internal:3000` 访问 API
- 本地开发需修改为 `localhost:3000`
- 所有工作流初始状态为 `inactive`，需手动激活
