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
