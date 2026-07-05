# Claude Code 项目全局强制约束（Onzo Ozon自动化 Phase1）

## 一、技术栈硬性禁止项（绝对不能生成/引入）

1\. 禁止 Python、Py相关代码、混合多语言调用

2\. 禁止 LangGraph、LangChain 复杂Agent框架，仅允许简单线性流程

3\. 禁止 Qdrant 独立向量数据库（已使用 PostgreSQL + pgvector 替代，RAG 知识库已上线，所有 Agent 强制引用，详见 `docs/rag-mandatory-reference.md`）

4\. 禁止 Redis、MQ、Kafka 等中间件，仅允许SQLite本地文件存储

5\. 禁止影刀RPA、浏览器自动化兜底逻辑（Phase2才接入，一期只走API）

6\. 禁止分布式集群、多机部署相关代码，仅支持单机Docker+SQLite单店架构



## 二、强制技术栈标准

1\. 全栈统一 TypeScript / Node.js，pnpm monorepo 分包架构

2\. HTTP服务：Express；爬虫：Playwright；数据库：better-sqlite3 + Drizzle ORM

3\. 模型调用：仅GLM-4.6V-Flash（主视觉OCR）、GLM-5.2（文本翻译/类目），GLM-5V-Turbo仅作为复杂比价可选补充

4\. 电商接口：Ozon Seller API v3，基于自研 ozon-api-wrapper（令牌桶限流+熔断+指数退避）

5\. 部署：Docker + docker-compose，仅启动 api-services + n8n 两个容器

6\. 流程编排：仅使用n8n固定线性工作流，不做自主动态推理Agent



## 三、项目目录结构规范（代码必须匹配该分包）

## 分阶段允许/禁止清单（Phase1 / Phase2 / Phase3）

- Phase1 (必须遵守，当前开发优先级):
  - 禁止：Python、LangGraph/LangChain、Qdrant独立向量库（已有pgvector替代）、Redis/MQ/Kafka、未经审计的影刀RPA、分布式多机部署
  - 允许：TypeScript/Node.js、pnpm monorepo、Express、Playwright、better-sqlite3 + Drizzle、单机 Docker + n8n、PostgreSQL + pgvector（RAG知识库已上线）

- Phase2 (受控评估后可引入):
  - 允许（受审批）：影刀RPA 兜底通道（仅在 API 熔断情形并经安全审计）、RAG 知识库深度集成（强制所有 Agent 引用，详见 docs/rag-mandatory-reference.md）、多店铺风控策略的配置框架
  - 仍禁止：未审计的第三方复杂 Agent 框架、生产环境下的分布式数据库替换（需满足运维/安全评估）

- Phase3 (长期规划与扩展):
  - 允许：Qdrant 向量库（备选，pgvector已为首选）、LangGraph/复杂 Agent 框架、PostgreSQL 分布式部署（当达到 ≥10 店并通过安全与成本审查）

说明：`docs/architecture.md` 中的 P2/P3 方案为长期架构目标；但当前仓库硬性约束以本文件为准（Phase1 禁止项为强制规则）。在推进 Phase2/3 的任何改变前，请提交 PR 并完成安全、成本与隐私评估。


├── packages/

│ ├── shared-types/ # 全局 TS 类型定义

│ ├── ozon-api-wrapper/ # Ozon 底层 SDK，优先开发

│ ├── ai/ # GLM 模型统一封装

│ ├── scraper/ # Playwright 1688 爬虫

│ └── validator/ # 商品上架前置校验

├── apps/api-services/ # Express 统一接口服务

├── n8n/workflows/ # n8n 工作流 JSON

├── docker/ # 容器构建配置

├── docker-compose.yml

└── docs/architecture.md


## 四、开发顺序强制依赖

1\. 先完成 `packages/ozon-api-wrapper`

2\. 再开发 shared-types、ai、scraper、validator

3\. 其次实现 apps/api-services 流水线接口

4\. 最后配置n8n工作流，编写端到端Vitest测试



## 五、代码输出规范

1\. 所有代码必须带完整TS类型，复用 shared-types 内定义，禁止any

2\. 所有外部API（Ozon/GLM/爬虫）必须增加错误捕获、重试、限流逻辑

3\. 所有数据库操作使用事务，处理SQLite并发写入锁冲突

4\. 代码拆分到对应分包目录，禁止跨包逻辑耦合

5\. 关键函数附带Vitest单元测试示例

## 模型调用规范
1. 商品图片OCR、图文卖点提取固定使用 glm-4.6v-flash（智谱免费视觉模型，不可替换）
2. P0商品上架标准文本任务（翻译、属性填充、四级类目匹配）统一 deepseek-v4-flash，替代原GLM-5.2
3. P2多竞品长截图比价、市场深度趋势推理，允许使用 deepseek-v4-pro，其余场景禁用Pro控成本
4. 所有大模型请求统一封装至 packages/ai，业务层禁止直接调用模型原始接口
5. 强制输出标准JSON结构，内置重试逻辑处理模型输出格式异常

## 环境变量规范
1. 项目根目录必须存在 .env 文件，所有密钥、模型名称、端口、数据库路径统一在此配置，由 packages/ai/src/config.ts 统一导出；；
2. AI模型密钥分为 GLM_API_KEY、DEEPSEEK_API_KEY 两套，禁止硬编码密钥至代码；
3. 文本模型区分 deepseek-v4-flash（主力上架）、deepseek-v4-pro（比价专用），通过环境变量统一管控；
4. .env 文件加入 .gitignore，禁止提交至代码仓库，提供 .env.example 模板供部署使用。
5. 所有第三方密钥（GLM、DeepSeek、Ozon）统一存放在项目根 .env 文件，
7. 不允许在业务代码直接读取 process.env，必须导入 config.ts 封装后的配置对象。

## Claude Code 代码生成强制规范
1. 调用大模型分层规则：视觉OCR固定 glm-4.6v-flash；上架翻译/类目匹配使用 deepseek-v4-flash；仅多竞品深度比价允许 deepseek-v4-pro；
2. 所有密钥、接口地址、模型名称、并发参数统一读取项目根.env，通过packages/ai/src/config.ts统一导出，禁止硬编码sk密钥、URL、模型名；
3. 代码必须完整TS类型，复用shared-types内定义，拒绝any；全部外部API增加重试、异常捕获、限流逻辑；
4. 严格遵守Phase1约束：不引入Python、LangGraph、Qdrant独立向量库、Redis、影刀RPA、分布式集群；仅单机Docker+SQLite单店架构；RAG知识库已通过pgvector上线，所有Agent必须引用；
5. 代码按Monorepo分包输出，存放路径匹配项目目录结构，支持Vitest单元测试扩展。

# 安全与边界强制审查规范
1. 密钥安全
   - 所有API密钥、店铺凭证仅存放根目录.env，禁止代码硬编码；
   - 服务启动校验所有必填环境变量，缺失直接终止进程；
   - 日志、报错输出脱敏，绝不打印sk、client_id、token等敏感字符；
   - .env加入.gitignore，仅可提交空白.env.example模板。

2. 大模型成本边界管控
   - GLM-4.6V-Flash、DeepSeek独立令牌桶并发限流，数值由.env配置；
   - 标准上架流水线代码层拦截deepseek-v4-pro，仅复杂比价任务允许启用；
   - 自动统计每日Token消耗存入SQLite，超阈值输出告警日志；
   - 超长图文输入自动截断，避免无意义高额Token损耗。

3. Ozon店铺风控边界
   - ozon-api-wrapper内置单店铺独立QPS限流、指数退避、熔断；
   - 连续风控/403报错自动冻结对应店铺任务，写入异常队列；
   - 上架、调价、订单同步内置随机延时，规避机器批量特征；
   - validator前置校验商品参数，非法数据直接拦截，不调用Ozon接口。

4. SQLite数据库安全
   - 全部查询使用Drizzle ORM参数化语句，禁止手写拼接SQL；
   - 用户收件电话、地址等敏感数据日志脱敏；
   - 任务队列设置最大存储上限，防止磁盘溢出。

5. API服务安全
   - 所有接口入参使用JSON Schema强校验，拦截恶意入参；
   - 全局请求超时兜底，避免进程卡死；
   - 可选接口访问密钥鉴权，n8n调用携带Header校验，外部不可随意触发自动化流水线；
   - 生产环境错误响应屏蔽代码堆栈，仅本地开发展示详情。

6. 爬虫访问边界
   - Playwright浏览器并发池上限由.env统一控制；
   - 抓取失败自动冷却降速，防止1688 IP封禁。

## 强制落地配套能力（Phase1上线必实现）
1. 日志规范
  - 使用统一 packages/logger 工具，禁用console原生打印；
  - 日志分级存储，敏感信息自动脱敏，按日期分割限制文件大小。
2. 统一错误体系
  - shared-types 定义全局业务错误枚举，自定义Error类携带标准化错误码；
  - Express全局异常中间件，所有接口返回统一JSON错误结构，便于n8n分支判断。
3. 失败任务队列
  - SQLite实现死信任务表，区分可自动重试/永久失败任务；
  - 网络类错误最多重试3次，风控、参数违规直接进入死信队列。
4. 健康检测
  - 提供 /api/health 检测接口，校验密钥、数据库、模型、Ozon接口连通性；
  - n8n定时轮询，异常输出告警。
5. 资源保护
  - 浏览器池、LLM并发、数据库写入全部做限流排队；
  - 单任务全局超时强制终止，防止进程卡死，阈值由.env配置。
6. 本地数据备份
  - 内置SQLite定时备份逻辑，自动保留7天备份文件，失败日志告警。
7. 双层参数校验
  - HTTP入参JSON Schema校验；
  - validator模块校验商品价格、数量、图片，拦截高风险违规数据。
8. 基础统计看板
  - SQLite存储上架量、Token消耗、接口限流统计；
  - 提供 /api/stats 接口导出运营报表。
9. 多环境隔离
  - 区分dev/prod环境变量，开发环境禁止真实创建Ozon商品，减少成本损耗。
10. 幂等防重复
  - 商品URL作为幂等键，短时间重复请求直接拦截，防止重复调用模型与Ozon接口。

## Ozon图片上传接口强制规范
1. 禁止使用 /v3/media/upload、/v1/media/upload，该路径不存在，会返回404
2. 外链批量导入商品图固定接口：POST https://api-seller.ozon.ru/v1/product/pictures/import
3. 本地二进制图片上传域名固定为 upload.ozon.ru，端点 /v1/upload，不可使用api-seller域名传文件
4. 铺货流水线优先使用URL导入接口，减少本地文件上传开销
5. 所有图片接口统一封装至 ozon-api-wrapper，内置URL校验、图片格式拦截、重试限流

## 本次E2E验证新增强制约束
1. Ozon接口固定可用端点
   - 类目树：仅使用 /v1/description-category/tree，禁止 /v3/category/tree（404）
   - 商品图片外链导入：POST /v1/product/pictures/import，废弃所有 /media/upload 路径
   - 本地文件上传域名 upload.ozon.ru/v1/upload，不可复用api-seller域名
2. DeepSeek v4 输出兼容逻辑
   解析模型返回优先读取content，为空时自动降级读取reasoning_content提取结构化内容
3. 定价换算规则
   人民币转卢布公式：售价 = 成本 × 汇率 × 利润率，禁止额外 *100 放大倍率
4. 资源池管控
   所有爬虫抓取统一走BrowserPool实例，手动输入场景不可绕过浏览器池限流、回收逻辑
5. 测试覆盖强制要求
   ai/validator/scraper模块必须配套单元测试，新增功能同步补充Vitest用例
6. 降级机制
   所有外部API（LLM/Ozon/爬虫）必须引入fallback.ts降级逻辑，失败不直接中断全链路

## 订单模块强制编码规范（Phase1）

1. 鉴权与凭证
   - 订单接口调用必须使用 `Client-Id` + `Api-Key` 鉴权，复用 `packages/ozon-api-wrapper` 的多店铺鉴权逻辑。
   - 所有店铺凭证集中存放于根目录 `.env`，不允许硬编码或散落在代码中。

2. 数据脱敏与日志
   - 订单敏感字段（收件人姓名、电话、地址、支付信息）在日志中必须脱敏；仅保留用于调试的最小可识别信息（如订单号、店铺ID、时间戳）。
   - 错误上报中禁止包含原始凭证或完整地址信息；仅携带脱敏后的唯一标识符。

3. 幂等与库存保护
   - 订单同步与扣减库存必须设计幂等：以 Ozon `order_id` + `storeId` 为幂等键记录处理状态，重复拉取不重复扣减。
   - 扣减库存应在事务内完成（Drizzle ORM），并写入操作日志；若扣减失败必须回滚并记录到死信队列。

4. 拉取策略与限流
   - 拉取订单接口必须支持分页与游标，单次请求最大页大小受限（配置项 `ORDER_SYNC_PAGE_SIZE`），并通过 ozon-api-wrapper 的限流策略降低风控风险。
   - 高并发拉取需加随机抖动与退避，连续失败达到阈值应触发店铺冻结（写入异常队列）。

5. 白名单与环境隔离
   - 生产环境只允许预定的 Ozon 订单接口路径（文档中列出），其他未知端点禁止访问。
   - 开发环境必须启用 Mock 服务（ENV=dev），避免调用线上真实订单数据或变更库存。

6. 测试与回归
   - 新增 `packages/ozon-order` 时必须包含 Vitest 单元测试和集成测试用例（模拟 Ozon 返回、断网、重复事件）。
   - 编写端到端用例验证：首次同步、重试幂等、库存扣减回滚、死信入队。

7. 错误处理与降级
   - 订单处理异常应分级处理：暂时性网络/限流错误可重试（指数退避），验证错误/权限错误写入死信并人工介入。
   - 提供手工重跑接口（受限权限）以重新处理死信队列中的订单。

## Phase1 P0 遗留优化强制规范
1. LLM Token 统计
   - 所有 DeepSeek/GLM 调用必须写入 token_usage 统计表（model, prompt_tokens, completion_tokens, timestamp）
   - .env 配置 LLM_DAILY_TOKEN_LIMIT，超出阈值自动拦截并告警
   - 提供 /api/stats/llm 接口导出每日消耗
2. SQLite 自动备份
   - 封装备份逻辑至 packages/common-utils
   - 自动备份到 ./data/backups/，保留 7 天滚动清理
   - n8n 每日凌晨定时触发 POST /api/db/backup
3. 死信队列批量重试
   - POST /api/task/deadletter/retry-batch 批量重跑失败任务
   - n8n 失败分支增加批量重试节点
4. 开发环境 Mock 隔离
   - ENV=dev 时 Mock 全部外部接口（Ozon/DeepSeek/GLM）
   - 不消耗线上 API 额度，不真实创建草稿