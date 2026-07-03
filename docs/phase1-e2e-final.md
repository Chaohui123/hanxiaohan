# Phase 1 E2E 最终交付记录

## 合并上线

- **日期**: 2026-07-03
- **分支**: `feature/e2e-pipeline-fix-docs` → `master`
- **提交**: `268ceef merge: feature/e2e-pipeline-fix-docs → master`

## 核心交付

| 模块 | 状态 | 说明 |
|---|---|---|
| 1688 爬虫 | ✅ | Playwright + 反爬对抗 + 浏览器池 |
| GLM-4.6V OCR | ✅ | 智谱免费视觉模型，商品图文字提取 |
| DeepSeek-V4 翻译/类目 | ✅ | 中译俄 + Ozon 四级类目匹配 |
| 数据校验 | ✅ | 价格/图片/标题/尺寸双层校验 |
| Ozon 草稿创建 | ✅ | 图片 URL 直传，type_id 自动解析 |
| 熔断/限流/降级 | ✅ | 令牌桶 + 指数退避 + 死信队列 |
| 测试覆盖 | ✅ | 44 tests, 0 any, 6 files |

## E2E 验证结果

```
POST /api/process/manual
Input:  { title, priceCny, specImages, specifications }
Output: { success: true, titleRu, categoryName, priceRub, imagesUploaded }
```

## 待开发清单

### P0 (Phase 1 遗留)
- [ ] LLM Token 消耗统计 + 单日成本熔断
- [ ] SQLite 自动定时备份
- [ ] 死信队列批量重跑接口
- [ ] 开发环境 Mock 接口隔离

### P1 (Phase 2 订单履约)
- [ ] Ozon 订单同步 (packages/ozon-order)
- [ ] 物流履约校验 + 库存扣减

#### P1 订单迭代任务清单（细化）
- [ ] 初始化 `packages/ozon-order` 包结构，包含 `client`, `sync`, `webhook`, `tests` 子模块
- [ ] 复用 `packages/ozon-api-wrapper` 的 `AuthManager` / 限流逻辑，支持多店铺凭证
- [ ] 实现订单同步（分页游标），支持 `ORDER_SYNC_PAGE_SIZE` 配置与抖动
- [ ] 设计并实现幂等处理：以 `storeId:orderId` 为幂等键记录处理状态（数据库唯一索引）
- [ ] 库存扣减在事务内完成，失败回滚并写入死信队列
- [ ] 提供手工/自动重跑接口，支持对死信订单批量重试
- [ ] 实现 webhook 消费逻辑（事件去重、签名校验、脱敏日志）
- [ ] 单元 + 集成测试：模拟 Ozon 成功/429/5xx/重复事件场景
- [ ] 本地 Mock 服务（ENV=dev）用于开发、CI 不调用线上接口
- [ ] 安全审计：日志脱敏规则、权限白名单、错误上报策略文档化

#### 分支与自测建议
1. 新建独立功能分支以隔离开发：

```powershell
git checkout -b feature/p1-ozon-order-sync
```

2. 本地自测步骤（建议）：
- 安装依赖并运行单元测试： `pnpm install && pnpm -w test --filter packages/ozon-order`
- 启动 dev 环境（Mock 模式）：`ENV=dev pnpm --filter apps/api-services dev`
- 运行集成测试：使用提供的 Mock 服务模拟 Ozon 返回场景

3. 合并规范：完成自测 + 全量 44 测试通过 + 新增订单测试通过后提交 PR，进行代码评审并合入 `master`。

#### 前置提醒（规避踩坑）
1. 订单接口同样需要 `Client-Id + Api-Key` 鉴权，复用现有多店铺密钥逻辑
2. 订单同步增加幂等设计，避免重复拉取重复扣减库存
3. 拉取订单接口做分页限流，防止高频调用触发 Ozon 风控封禁店铺
4. 开发环境自动 Mock 订单接口，不请求线上真实订单数据

### P2 (体验优化)
- [ ] n8n Token 监控/备份巡检工作流
- [ ] Excel 批量铺货
- [ ] 轻量化前端管理面板
