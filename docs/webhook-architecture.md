# Ozon 对接模块 — Webhook 事件驱动架构

> 架构：**Webhook 事件驱动为主 + API v3 定时兜底**
> 接收器只做：验签 → 原始请求落库 → 立即 200。全部业务逻辑由 drain job 异步消费。
> 队列限流：ozon-api-wrapper 令牌桶 + 熔断 + 指数退避（遵守 rules.md 禁 Redis/MQ 约束，不使用 BullMQ）。

## 一、目录结构

```
apps/api-services/src/
├── routes/
│   └── webhook.route.ts          # 接收层：/ozon/webhook + /api/webhook/ozon（验签/落库/200/replay）
├── services/
│   ├── webhook-drain.ts          # 异步消费者：drain ozon_webhook_log（乐观锁防重）
│   ├── order-processor.ts        # 订单履约服务（新单/状态变更/取消）
│   └── ozon-order-sync.ts        # API 兜底同步（5min 补偿）
├── jobs/
│   └── setup.ts                  # webhook-event-drain(30s) + order-sync(6h 对账)
├── db/
│   ├── schema.ts                 # ozon_webhook_log DDL（PG）
│   └── migrations.ts             # 同上（迁移执行）
packages/
├── ozon-api-wrapper/             # 统一 v3 客户端（令牌桶限流/熔断/退避/请求日志/零硬编码）
└── ozon-order/
    ├── webhook.ts                # 验签(HMAC-SHA256+timingSafeEqual) + event_id 幂等
    └── sync.ts                   # /v3/posting/fbs|fbo/list 兜底拉取
docker/caddy/Caddyfile            # HTTPS 终止 + /ozon/webhook 转发
```

## 二、数据流

```
Ozon ──POST /ozon/webhook──> Caddy(HTTPS) ──> api-services
  ① 验签 (HMAC-SHA256, timingSafeEqual)
  ② event_id 幂等 (webhook_events ON CONFLICT + ozon_webhook_log.event_id UNIQUE)
  ③ INSERT INTO ozon_webhook_log (process_status='queued', payload_json=原始报文)
  ④ 立即 200 {"result":{}}
                                      │
webhook-event-drain job (每 30s) <────┘
  ⑤ SELECT ... WHERE process_status='queued' LIMIT 10（乐观锁 queued→processing）
  ⑥ handleWebhookEvent → order-processor（新单扣库存/状态变更/取消）
  ⑦ UPDATE process_status='done'|'failed'(error)
  ⑧ 失败 → 死信队列 + 人工 POST /api/webhook/replay/:id 重跑

兜底：ozon-order-sync-v2 job 每 5min 调 /v3/posting/{fbs,fbo}/list 补偿丢失事件；
     order-sync job 每 6h 深度对账。
```

## 三、建表 SQL

```sql
CREATE TABLE IF NOT EXISTS ozon_webhook_log (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,          -- 幂等键
  event_type TEXT NOT NULL,
  posting_number TEXT,
  order_id BIGINT,
  status TEXT,
  signature TEXT,
  client_ip TEXT,
  payload_json TEXT NOT NULL,             -- 原始报文
  process_status TEXT NOT NULL DEFAULT 'queued',  -- queued/processing/done/failed
  error TEXT,
  received_at TIMESTAMP DEFAULT NOW(),
  processed_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_owl_posting  ON ozon_webhook_log(posting_number);
CREATE INDEX IF NOT EXISTS idx_owl_status   ON ozon_webhook_log(process_status);
CREATE INDEX IF NOT EXISTS idx_owl_received ON ozon_webhook_log(received_at);
```

## 四、核心 TS 代码（接收器主流程）

```ts
// routes/webhook.route.ts — 验签通过且去重后：
const logId = `owl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const db = await getDb().catch(() => null);
if (db) {
  await db.run(
    `INSERT INTO ozon_webhook_log
       (id, event_id, event_type, posting_number, order_id, status,
        signature, client_ip, payload_json, process_status, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NOW())
     ON CONFLICT(event_id) DO NOTHING`,
    [logId, payload.eventId, payload.eventType, payload.postingNumber,
     payload.orderId, payload.status, signature ?? null, clientIp, rawBody]
  );
}
// 立即 200 —— 业务逻辑全部移出请求路径
res.setHeader("Content-Type", "application/json; charset=utf-8");
res.status(200).send('{"result":{}}');
```

```ts
// services/webhook-drain.ts — 乐观锁防重复消费
const lock = await db.run(
  "UPDATE ozon_webhook_log SET process_status='processing' WHERE id=? AND process_status='queued'",
  [row.id]
);
if (lock.changes === 0) continue;       // 其他 worker 已取走
// ... handleWebhookEvent → order-processor ...
await db.run("UPDATE ozon_webhook_log SET process_status='done', processed_at=? WHERE id=?",
  [nowDb(), row.id]);
```

## 五、Caddy 配置（docker/caddy/Caddyfile 关键段）

```caddy
# HTTP 块（Ozon 注册探测用）
handle /ozon/webhook {
    reverse_proxy api-services:3000
}

# HTTPS 块
handle /ozon/webhook {
    reverse_proxy api-services:3000
}
```

Ozon 后台登记 URL：`https://{CADDY_DOMAIN}/ozon/webhook`
（旧路径 `/api/webhook/ozon` 继续兼容，两者同一处理器）

## 六、API v3 客户端规范（ozon-api-wrapper）

- 凭证：仅 `OZON_CLIENT_IDS` / `OZON_API_KEYS` 环境变量（多店铺逗号分隔），`AuthManager` 隔离；**零硬编码**
- 限流：令牌桶（每店独立 QPS）+ 分片错峰
- 重试：429/5xx 指数退避（1s→2s→4s，full jitter），4xx 不重试
- 熔断：连续 3 次 429/5xx → OPEN → 30s 半开探测
- 日志：pino 结构化请求日志（含脱敏）

## 七、部署启动命令

```bash
# 服务器（自动）：deploy-watch cron 每 5 分钟检测 origin/main 自动部署
bash /home/ubuntu/onzo/scripts/deploy/deploy-watch.sh   # 或手动触发一次

# 手动部署
cd /home/ubuntu/onzo && git fetch origin && git reset --hard origin/main
docker compose --profile production --env-file .env.production up -d --build

# 验证
curl https://<domain>/ozon/webhook                     # GET → 200（注册探测）
docker exec onzo-postgres psql -U onzo -d onzo_prod -c '\d ozon_webhook_log'
docker logs onzo-api | grep webhook-event-drain

# 人工重跑失败事件
curl -X POST https://<domain>/api/webhook/replay/<logId> -H "X-API-Key: $API_KEY"
```

## 八、兼容性承诺

- 1688 采购链路（manual-procurement jobs）、CDEK/跨境巴士物流履约（logistics/transition jobs）不受影响
- 订单同步双保险：webhook 实时 + 5min API 补偿 + 6h 对账；存量 `webhook_events` 去重表继续服役
- 全程仅 Ozon 官方 API + Webhook，无前台爬虫逆向，店铺风控安全
