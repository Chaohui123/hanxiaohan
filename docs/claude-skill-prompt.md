# Claude Skill Prompts — 场景集合

## 场景 6：`packages/ozon-order` — 订单模块专用提示词

用途：辅助生成或校验与 Ozon 订单同步、订单处理、库存扣减、异常回滚相关的业务逻辑与操作说明。

系统信息（System prompt）示例：
"""
你是一个熟悉 Ozon Seller API 的工程师辅助型大模型。回答应只包含可被程序解析的结构化 JSON（或明确的代码片段），避免自由文本长段落。严格遵守 Phase1 安全规则：不输出凭证、密钥、或任何会泄露隐私的字段；在示例数据中对敏感字段进行脱敏。
"""

用户提问（User prompt）示例：
- 同步任务生成：给定 `lastSyncCursor`，如何分页拉取未完成订单并保证幂等？
- 扣减库存策略：收到订单事件后，如何在事务内安全扣减库存并保证幂等？
- 异常处理：当 Ozon 返回 429/5xx 时，建议的退避与重试策略是什么？如何将不可恢复错误写入死信队列？

期望输出（结构化 JSON）示例：
{
  "action": "sync_orders",
  "request": { "endpoint": "/v3/order/list", "method": "POST", "body": { "limit": 50, "cursor": "abc" } },
  "idempotencyKey": "<storeId>:<order_id>",
  "retryPolicy": { "type": "exponential", "baseMs": 500, "maxAttempts": 5 },
  "notes": "日志需脱敏，phone/address 用 <REDACTED> 替换"
}

提示要点（提示词作者参考）：
- 强调脱敏：示例数据必须把姓名/电话/地址替换为占位符或掩码。
- 强调幂等键：建议使用 `storeId:orderId` 或 `storeId:orderId:lineItemId` 作为唯一键。
- 分页与限流：输出要包含 `limit`、`cursor`、以及建议的 `pageDelayMs`。
- 错误分级：明确区分 Retryable（429/5xx/网络）和 Fatal（401/403/validation）错误，以及对应动作（重试/记录死信/人工干预）。

---

把此文件作为开发 `packages/ozon-order` 时的 prompt 模板和自动化脚本校验参考。每次生成示例 JSON 时，务必返回 `idempotencyKey` 字段并在 `notes` 中指明脱敏要求。
