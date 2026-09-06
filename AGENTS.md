# AGENTS.md

## 用户习惯

- **全程使用中文**：与用户的所有交流（回复、进度说明、提问）以及思考链路（reasoning/thinking）都必须使用中文。代码、命令、标识符、文件路径保持原文。

## 知识库使用规则（防"学过用不上/压缩失忆"）

- **开工前先检索**：涉及选品、文案、调价、主图设计、上架、平台规则的任务，动手前先跑知识库检索，把相关条目读进来再行动：
  - 命令：`node temp/kb-search.cjs "查询词" [topK] [scenario]`（scenario 可选：learning/ops/sop/platform-rules/compliance/pricing/design/aftersales/competitor/market）
  - 例：`node temp/kb-search.cjs "Ozon 主图设计 点击率" 5 design`
- **SOP 入口**：`docs/current-pipeline.md` 第九节是当前工作状态与各链路教训的总索引；压缩恢复/新会话先读它再动手。
- **派子代理**：prompt 必须写明 SOP 路径+先用 `temp/kb-search.cjs` 检索相关条目；零上下文子代理禁止直接操作生产数据（Ozon 商品/价格/库存）。
- **新知识入库**：实战中验证过的经验/踩坑走知识门禁入库（knowledge-gate：边界+真实性+语义查重），不要只留在对话里。

## 工作方式（子代理分工与上下文控制）

- **分工矩阵**（2026-09-06 用户定调：质量与效率优先）：
  - 调研/探索/资料收集 → `explore` 子代理（只读，可多个并行；产出=精简结论，不把原始大文件倒回主上下文）
  - 代码修改/多文件重构 → `coder` 子代理（prompt 带全上下文：目标文件路径、相关代码片段、验收标准）
  - 实施前方案设计 → `plan` 子代理（复杂功能先出方案评审再动手）
  - 质检 → 独立子代理交叉复核（与生产者不同实例，对照验收标准逐条过）
  - **浏览器采集（WebBridge/Chrome 操作）一律主 Agent 直跑，禁止派子代理碰浏览器**（串页/卡死教训，见 current-pipeline.md 第九节）
- **上下文控制**：
  - 主 Agent 只做：任务拆解、分发、浏览器/生产 API 直跑、汇总建议；大件调研/批量文件处理下沉子代理
  - 子代理 prompt 三要素：目标（含完成判据）+ 已知信息（路径/账号/约束）+ 必读上下文（SOP 节号、知识库检索词）
  - 子代理返回只收结论与关键数据；中间产物落盘 temp/ 并给路径
  - 长任务分段：每完成一个可验证的里程碑就汇报/落盘，避免一次性大交付失控
- **工具增强**：优先复用已验证的开源 Skill/MCP（接入评估记录入知识库）；新工具接入前先在非生产数据上验证。
- **MCP 自动调用（2026-09-06 用户定调）**：已接 excel / ozon-buyer / deepl 三个 server，**需要时直接自动调用，不特意开启、不请示**（config.toml 已配 `mcp__excel__*` / `mcp__ozon-buyer__*` / `mcp__deepl__*` allow 规则，任何权限模式免审批）。典型场景：Excel 模板读写→`mcp__excel__*`；Ozon 前台选品调研/竞品价格评论→`mcp__ozon-buyer__*`；俄语翻译/术语统一→`mcp__deepl__*`。MCP 故障时降级到既有链路（WebBridge/API/DeepSeek 翻译）并告知用户。
