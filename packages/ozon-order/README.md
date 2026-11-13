# @onzo/ozon-order

Ozon 订单同步、Webhook 解析和库存处理工具包。该包已接入 api-services 的订单链路，不再是“待实现、不可用于生产”的 Phase 1 骨架。

## 模块

- `src/client.ts`：基于 `@onzo/ozon-api-wrapper` 的订单请求封装。
- `src/sync.ts`：FBS/FBO 增量同步、cursor 分页、幂等检查和同步指标；默认回看 7 天，也可显式指定时间范围。
- `src/webhook.ts`：兼容 Ozon 实际 `message_type` / `order_number` / `uuid` 报文及内部旧格式，提供事件分发与去重接口。
- `src/inventory.ts`：库存扣减、恢复和流水记录；池化 PostgreSQL 必须通过 `db.tx` 在单连接事务中执行。
- `src/index.ts`：公开导出上述客户端、同步、Webhook 与库存能力。

## 当前安全边界

- Ozon 实测推送通常不带 `X-Ozon-Signature`。签名存在时才进行 HMAC-SHA256 校验；接收端还需执行 seller_id 白名单及可选 IP 白名单，具体由 api-services 的 Webhook 路由完成。
- 订单与库存写入必须幂等、可审计并记录错误；单个异常订单不能伪装成整批成功。
- 本 README 不是生产写操作授权。商品、价格、库存的生产操作与回读终审只能由 Kimi 主 Agent 按 `AGENTS.md` 执行。
- 接收、消费、兜底同步和通知的完整数据流见 [Webhook 架构](../../docs/webhook-architecture.md)；实际行为以源码和测试为准。

## 验证

```bash
pnpm exec vitest run packages/ozon-order/tests
pnpm build
```

交付生产改动时还需运行全项目 `pnpm test`、`pnpm lint`，并按真实订单/Webhook 场景回读，不能只验证导出或类型编译。
