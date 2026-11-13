# AGENTS.md

## 用户习惯

- **全程使用中文**：与用户的所有交流（回复、进度说明、提问）以及思考链路（reasoning/thinking）都必须使用中文。代码、命令、标识符、文件路径保持原文。
- **尽全力完成任务，不许过早放弃（2026-10-24 用户批评定调）**：遇到卡点（表单组件封闭/接口报错/工具故障）不准"差一点就放弃转交给用户"——必须穷尽所有可行路径（换选择器/换工具/换 API/换脚本方案/截图逐像素定位/读官方文档找替代通道），把任务做到真正闭环。只有确实撞上硬墙（官方功能未开放/需要用户敏感信息如卡号/需要用户生物验证）才交还用户，且要说明已穷尽的所有尝试。耗时不是放弃的理由。

## 知识库使用规则（防"学过用不上/压缩失忆"）

- **开工前先检索**：涉及选品、文案、调价、主图设计、上架、平台规则的任务，动手前先跑知识库检索，把相关条目读进来再行动：
  - 命令：`node temp/kb-search.cjs "查询词" [topK] [scenario]`（scenario 可选：learning/ops/sop/platform-rules/compliance/pricing/design/aftersales/competitor/market）
  - 例：`node temp/kb-search.cjs "Ozon 主图设计 点击率" 5 design`
- **SOP 入口**：`docs/current-pipeline.md` 第九节是当前工作状态与各链路教训的总索引；压缩恢复/新会话先读它再动手。
- **派子代理**：prompt 必须写明 SOP 路径+先用 `temp/kb-search.cjs` 检索相关条目；零上下文子代理禁止直接操作生产数据（Ozon 商品/价格/库存）。
- **新知识入库**：实战中验证过的经验/踩坑走知识门禁入库（knowledge-gate：边界+真实性+语义查重），不要只留在对话里。
- **知识与SOP定期维护（每周）**：复用服务器 `knowledge-janitor` 每周清理（TTL、低质、语义重复、明确取代关系），周复盘同步检查项目自有 Markdown 与知识条目的现行性：覆盖根目录、`.claude/`、`.github/`、`docs/`、`docker/`、`packages/`、在用工具说明及 `temp/` 中仍承担现行说明的文件，不仅维护主状态文件。`temp/` 历史调研、虚拟环境和第三方安装/许可证文档不当作 SOP，也不为追求数量强行改写。先备份，再删除已被新验收取代的废弃条目；历史实证必须标日期与“当时/历史”，不得把未修、待部署、旧任务或旧模型路由留成当前规则。只由 Kimi 对照真实代码/生产回读执行替换或清理，模型不得自行删除知识或改写 SOP。
- **Google 官方知识核验（2026-10-26）**：官方型号、接口、价格等声明必须提供白名单 Google 官方链接，由门禁抓取原文并交 DeepSeek 对照审核；域名本身不是证据，取不到原文、证据不支撑或审核失败均拒入。项目实测与官方声明分开，禁止手写 SQL 绕过门禁。

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
- **代理使用规则（2026-10-20 用户定调）**：访问外网（Google/Gmail/YouTube/ChatGPT/WIPO 等被墙或国际站）前**先检查系统代理是否开启**（ProxyEnable 注册表值），未开则先开（v2rayN 常驻，混合端口 127.0.0.1:10808）；**任务用完必须立即关闭**（ProxyEnable=0），避免影响其他工作的网络。开关法：PowerShell `Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' ProxyEnable 0|1`，改完跑 `powershell -NoProfile -ExecutionPolicy Bypass -File temp/refresh-proxy.ps1` 即时生效。国内站（1688/Ozon/淘宝/百度）与国内 API 调用一律直连不走代理；外网 API（Google、OpenAI、Yandex Direct 等）由脚本显式指定 `127.0.0.1:10808`，不必因此开启系统代理，本机 Direct 日报依赖该代理服务在运行；curl 外网验证可用 `-x http://127.0.0.1:10808` 显式指定（不动系统代理）。
- **商品图素材规则（2026-10-21 用户定调）**：图片素材**优先保证高清实拍效果好**，不要局限于 1688——1688 只是首选渠道不是唯一渠道；1688 图不可用（水印/低分辨率/雾面）时**必须扩展其他渠道**：速卖通 AliExpress、Wildberries、Ozon/Yandex 图床、俄罗斯汽配站（exist/emex/kitzap/zap-china 等）、Google/Yandex 图片溯源。素材优先级：①无水印高清实拍（任何渠道，必要时抠图换白底自制）②供应商原图程序去水印（质感有损时放弃）③AI 生成（仅作兜底，形状必须与实物一致）。红线不变：无中文/无水印/无 logo；同行图禁止原样照搬（抠图/排版二次加工才可）。

## 三模型协作（Kimi × Codex/GPT × Google，2026-10-25 升级）

- **分工矩阵**（按任务选模型，不为用满套餐重复跑）：
  - **Kimi 699（主力，默认）**：日常运营全链路——浏览器自动化/生产 API 操作/SOP 执行/子代理编排/知识库维护/中文沟通/俄语文案初稿与最终验收。生产数据（Ozon 商品/价格/库存）**只有 Kimi 主 Agent 可碰**。
  - **OpenAI ChatGPT Plus $20（辅助智囊）**：只做分析/生成，不直接操作生产数据。①深度测算与重大决策攻坚 → **astra**（最贵省着用）②批量俄语/英语文案精修 → **luna**。统一走 `bash temp/gpt-assist.sh <luna|astra> "<prompt>" [sandbox]`；长 prompt 用 stdin，收窄上下文，禁止裸跑 codex。原 **terra** 的日常代码、桌面任务与文案职责自 2026-11-13 起切换到 Gemini 4 Hydrogen，旧 terra 入口明确拒绝并提示新命令，不静默回退 GPT。
  - **Google AI Pro（多模态与视觉辅助）**：只做分析/生成，不直接操作生产数据。①Gemini 4 Argon → 重大选品/定价第二意见、长文档及高风险图文/视频/PDF 交叉复核；日常视觉理解由 Hydrogen 承担 ②Nano Banana 2.1 / Omni → 图像/视频制作 ③Gemini/Flow → 人工创作与复核。应用额度按算力消耗，不是无限；只有高价值/高风险任务才与 GPT 交叉复核。
  - **Antigravity / Gemini 4 Hydrogen（2026-11-14 改区后恢复）**：接替 Terra 的日常代码、bug 定位、桌面任务分析与文案辅助，并承担日常视觉理解、图片和截图复核。统一使用 `python scripts/gemini-hydrogen.py --prompt-file <文件> --output <JSON> [--image <图片> ...]`，模型固定 **`gemini-4-hydrogen-high`**，High + sandbox + `request-review`，不得静默换模或跳过权限。每次保存并校验实际模型、正文、usage 和工具调用；只有实际模型一致、`SUCCESS`、正文非空且用量有效才成功，请求 HIGH 不等于实际 HIGH 已回读。图片记录路径与 SHA-256，不保存 base64 或密钥；视觉任务必须有 `read_file` 或 `view_file` 实际读取证据，不能只按文本推断。只做非生产分析/生成，Kimi 负责实际生产操作与终审。
  - **Google AI Studio / Gemini 4 Carbon（独立备选，不再默认接替 Opus）**：保留复杂跨文件代码审计、竞品证据、经营分析、分镜与经济复核的独立只读能力及既有 Direct 规划脚本，通用审查仍用 `python scripts/gemini-carbon-review.py --prompt-file <文件> --output <JSON>`，固定 `gemini-4-carbon` 并保存实际模型、正文、finishReason、usage 和 prompt 哈希；仅实际模型一致、STOP 且正文非空才成功，失败不换模。Direct 全店规划继续复用既有 `gemini-carbon-plan.py`、`gemini-carbon-batch-plan.py`、`gemini-carbon-continue.py` 和历史证据；Carbon 不直接创建/启动广告、生成媒体或修改生产，实际经营与生产操作由 Kimi 复核执行。
  - **Antigravity Opus 5.5（2026-11-14 恢复原有流程）**：恢复复杂跨文件代码审计、竞品证据复核、周复盘经营分析、双视频/图卡分镜规划，以及选品/定价/单元经济交叉复核。统一使用 `node scripts/antigravity-run.mjs --prompt-file <文件> --output <JSON> --model claude-opus-5-5-high --effort high --sandbox`，执行器同时允许 Hydrogen High，其他模型和 effort 继续拒绝。每次校验实际模型、`request-review`、`SUCCESS`、正文和有效 usage；禁止第三方反代与 `--dangerously-skip-permissions`。2026-11-09 至 11-13 的地区失败保留为历史证据，不自动重试旧失败或把旧输出改名；只有本次美国地区生效后的真实回执才恢复。Hydrogen 负责日常代码、桌面任务与视觉理解，Astra 攻坚，Luna 批量文案，Argon 负责高风险多模态交叉复核，Carbon 仅作独立备选；所有辅助输出仍由 Kimi 复核，禁止生产写入。
- **额度与验收纪律**：Astra 只打攻坚、luna 跑批量文案，Hydrogen 负责日常代码、桌面任务分析与视觉理解（历史 5h 参考：astra 5-45 条、luna 350-3000 条，实际以账户页为准）；周上限前 80% 主动报告收紧。`gpt-assist.sh` 已内置 10808 代理注入，`codex login status` 可查登录态。Hydrogen 按 AI Studio 实际 usage 与账户额度记录，不能把 Pro 应用额度当 API 余额。Flow 积分不能当 API 余额；Pro 每月 Cloud 赠金须符合 API 使用资格且有有效预付余额才可抵扣，账号关联以 AI Studio Billing 为准。GPT/Google 产出必须由 Kimi 审核参数、合规和质量后才实施，禁止上传密钥、客户隐私或生产凭据。

## 无货源精准测品、停止恢复与桌面模型分工（2026-11-05 用户定稿）

- **业务结果才算交付**：搜索/下载/评审/审查文件只算过程；新品须生产上架+回读，整改须素材终审+线上更新+回读。无合格 SKU 是及时淘汰，不得包装成基本完成。
- **无货源硬顺序**：独立真实需求 → 竞争、供货、准确变体与关键参数 → 真实单元经济 → 完整 8 图+双视频制作 → 独立复核 → Kimi 上架测品 → 小批量出单后拿样 → 自拍更新与成本回写 → 放量复盘。不提前备货，前台测品额度为 5–10 件并须与供应商实际可发库存一致。
- **真实需求独立过闸**：至少取得一项商品词的 Yandex Wordstat 搜索量，或 Ozon 后台查询、类目、销售榜、本店数据或前台商品词/品类的真实需求数据；记录关键词、地区、时间窗、匹配操作符与原始回执并核验购买意图。同类跨境卖家的动销、在售和评价只能作竞争参考，不能独立证明需求，也不能因数据来自 Ozon 前台就绕过本闸门；相邻品、总成、镜片或车型大词不能替代目标商品需求。
- **样品后置**：初筛可用同一变体的供应商标重与保守重量/成本假设，累计 3 个有效付款订单后拿样，最迟不超过 5 单；实测整套重量、包装、接口及关键功能后回写成本与建品资料。商品身份、安全或关键参数不清仍须停止，不能用 AI 补造；自拍素材走出单拿样后的更新替代路线，不阻塞选品或首版内容制作。
- **利润与 CPS 分账**：持续经营净利率 ≥10% 可测、≥15% 优先，按拟用仓库/线路核价，不以未使用通道的最高运费否决；采购、国内运费、包装、佣金、物流、退货和支付等必要费用不得漏算。每 SKU 按 `5 × 预计成交价 × 实际CPS费率` 预留一周 CPS 预算，7 天或 5 个 CPS 订单先到即复盘；实际资格和费率以后台为准，不伪称已开启。测品总损益须计入实际 CPS、完整内容制作及已触发样品成本，预算内亏损只能记为测品投入，不冒充持续盈利，不自动续投或打开 `PROMO_AUTO_DECISION`。
- **内容标准不降**：完整 8 图和双视频仍是正式测品上架标准，选品与内容制作可并行；制作未完成是生产未完成而非选品 FAIL，但内容未齐不得上架。供应商授权不再设核验项、证明材料或停止条件，商品一致性、无中文/水印/logo、不原样照搬同行及连续真实动作等其他素材红线不变。
- **停止与复核**：每候选最多 2 家并行货源+1 家备选，做一次集中复查；真实需求、准确身份、关键供货、经济或合规证据不足才停止，不再因未拿样、无自拍或未取得供应商授权停止。需求/供货/经济复核通过后才付费制作，内容完成后做上架终审；FAIL 后不得按原证据继续，补证或关键条件变化须重过经济及受影响闸门，不无限扩搜或新建同类定时任务。
- **桌面模型**：日常电脑任务分析、写作文案与视觉理解优先 **Gemini 4 Hydrogen**，统一走 `python scripts/gemini-hydrogen.py --prompt-file <文件> --output <JSON> [--image <图片> ...]`；不再调用 `gpt-6.1-terra`。GPT/Gemini/Opus 仅做非生产分析/生成和经授权的非生产电脑任务辅助，实际桌面操作由 Kimi 或既有工具执行；Ozon 商品/价格/库存生产操作及生产回读终审只能由 Kimi 主 Agent 执行。
- **Direct**：付款人身份本身不单独决定投放，不豁免付款、账户、平台与合规核验；具体 campaign 仍须用户授权并核验利润/预算、广告法资料与 Ozon 集成，未全部通过不得创建或启动，不因付款人整改自动启动。`715426752` 已于 2026-10-27 经用户授权、全部闸门核验后启动；仅此 campaign，不得自动扩品或加预算。
- **汇报**：只报 PASS/FAIL、证据缺口、合格候选数、实际上架数、主动时间与模型成本，不把搜索/下载/工具调用次数当业务成果。

## 视频/图像/配音生成管线（2026-10-26：双视频 + 重点图精修 + 批量生成）

- **统一调用模块**：`temp/omni-gen/` 负责 Gemini/OpenAI 模型适配，`temp/video-pro-pipeline/run_one.py <video-plan.json>` 负责 Ozon 双视频编排；历史 GLM 脚本只留档，禁止用于新品。图片、视频和语音均按请求参数、参考文件与实际文件 SHA-256 保存 manifest，全部一致才复用，禁止“同名非空即复用”。
- **图像模型分工**：少量首图/精细图优先 `gpt-image-2.6-sunburst`（OpenAI 独立适配器；无 API Key 时走 ChatGPT Images 2.6 应用，Plus 不是 API 额度）；批量场景/图卡用 `gemini-nano-banana-2.1`。GPT Images 2.6 支持 complexity=low/medium/high（默认 high），局部编辑优先 low，编辑请求省略 `input_fidelity`；当前无 OpenAI API Key，未宣称 API 实图验收。2026-10-26 同图同题 Argon 盲评为 ChatGPT 96、Nano 88，重点图优先但不替换批量通道。GPT/Gemini 不静默互换；Nano 仅 429 有限重试后可回退 `gemini-3.1-flash-image`，5xx 停止并对账。
- **双视频规格**：成品统一 1080×1440（3:4）、MP4/H.264/yuv420p/faststart，时长 8–30 秒、内部 ≤18,000,000 字节（官方封面 ≤20MB）、fps 24 或 30 且同 SKU 一致。视频封面目标 12–15 秒，默认静音且不听声音也懂，优先零音轨；正常视频目标 20–26 秒，保留 Yandex SpeechKit 俄语原速配音和字幕。普通视频官方时长为 3 秒–5 分钟，这里只是内部主动收紧，不能误写成官方同规格。
- **源片与裁切**：Omni `response_format.aspect_ratio` 实测只支持 16:9/9:16，禁止传 3:4。源片按 9:16 生成，后期中央安全裁切到 3:4；比例不一致的 clip 必须显式记录 `reframe.mode="center_crop"` 和 `safe_center:true`，无 pad、无拉伸，并逐帧目检主体完整性。
- **内容与素材红线**：高清实拍优先，商品形状、接口、数量、颜色、兼容性不得由 AI 捏造；首图白底、8 图一图一信息任务、俄文后期程序排版，禁中文/水印/logo/人脸/车标。参考图/首尾帧生成不等于商品保真，结构或连接关系变形即弃用；上架前必须有经目检的连续动作素材，不能只用图片推拉冒充。视频封面不做图卡轮播，用连续镜头和大字短标签；正常视频先定原速配音再配画面，禁 `tpad`、`stream_loop`、句尾定格和配音变速。主图/图卡首次上架前定稿，避免在售换图重审。
- **成本纪律**：Nano 2.1/2 与 Omni API 免费档均不可用，2.1 图像参考价 1K/2K/4K=$0.0336/$0.0504/$0.113。Omni 1.2 720p 约 $0.07/秒；2026-10-26 的 Omni 1.1 1080p 5.013 秒样片为 43,440 output video tokens（$0.7602，另有输入），批量前重查 usage。OpenAI API 与 Plus 分账；`gpt-image-2.6-sunburst` 只经 `OPENAI_IMAGE_MODEL` 配置。付费失败、402/403/404/5xx 或结果不明不得自动重发，创建后记录脱敏 interaction_id，pending 不提前成功。
- **配音红线（2026-11-14 起）**：默认 **Yandex SpeechKit API v3 `marina+friendly`**，原速禁变速，GLM TTS 永禁用。`main.voice` 固定 `provider=yandex`、`model=speechkit-v3`、`name=marina`、`role=friendly`、`rate=+0%`；共享客户端在 `packages/yandex-cloud`，编排入口为 `temp/video-pro-pipeline/make_vo_yandex.py`。逐句生成并校验真实 WAV、完整解码和文本/音频 SHA-256，失败不自动重发付费请求、不静默换音色。历史 Edge 73、Gemini 55 仅作当时证据；2026-11-14 Marina 真实音频经 Argon 供应商隐藏盲评 PASS 96 分，STT 回读完整原句，当前优先 Yandex。新候选仍须真实音频模型盲评，禁止声音克隆和虚构逐词时间戳。
- **Yandex Cloud 搜索与其他 AI（2026-11-14）**：Wordstat 与网页搜索统一走 `packages/yandex-cloud` 和 `scripts/yandex-wordstat.mjs`，不再默认打开 Wordstat 前台；后端为 `/api/yandex-cloud/wordstat/top|dynamics|regions` 和 `/api/yandex-cloud/search`。原始关键词、操作符、地区、设备、时间窗与回执必须留证，关联词和缺失月份不等于目标需求或 0。**Translate** 经 `/api/yandex-cloud/translate` 只生成文案草稿，术语、品牌禁词和参数由 Kimi 终审，不替换 DeepSeek/Luna 终审链。**STT** 经 `/api/yandex-cloud/stt` 使用 OggOpus，配音首次验收或高风险任务可在 plan 显式设 `main.voice.stt_verify=true`，规范化回读与原文一致才替换正式音轨；默认不逐句计费复核，v1 同步 STT 不支持 MP3。**Vision OCR** 经 `/api/yandex-cloud/ocr` 使用 `text_detection_config` 并检查内层错误，STT/OCR 均须 `confirmNoSensitiveData=true` 才允许上传，语言标签和文字仍须复核，不默认上传采购或买家截图。服务账号 `onzo-yandex-api` 仅授予 TTS、STT、Translate、Vision、Search API 五项角色；密钥只在受控路径读取，不打印、不入库、不传模型；生产凭据只能通过带现有鉴权与 `confirmProductionUpload=true` 的 `POST /api/yandex-cloud/credential` 原子写入并设为600，禁止 Git、聊天或命令历史传递。Cloud Functions、Object Storage、Lockbox 只确认可访问，未实施迁移或新建资源。
- **代理与兜底**：生成请求必须注入 `HTTPS_PROXY=127.0.0.1:10808`（v2rayN 需在跑）；Gemini Key 仍由 `temp/gemini-key.txt` 读取，OpenAI Key 仅从环境变量读取，均禁止打印。GLM 不进自动回退，仅作人工灾难兜底。

## 竞品远程采集与周复盘（2026-10-27；2026-11-03 双价格与对账更新）

- **禁止本机抓竞品**：`temp/competitor-scan.py` 已停用且入口拦截。服务器 `tools/ozon-mcp-server/run-competitor-scan.sh` 每日 03:17 UTC 执行，`flock` 防重入；轻量 Node 容器通过公开 Google translate 代理读 Ozon composer JSON，非官方 API/SLA，不传 Seller 凭据。公共通道 429/403 或浏览器挑战失败时首条即熔断、非零退出且不覆盖正式 latest，禁止把全量失败请求当作补跑。代理配置与接口兼容见 `docs/proxy-setup.md` 末节。
- **链接先验证再落库**：先查生产映射和在售/归档状态，候选须过 SKU、标题、规格、左右侧与可售状态复核。归档映射先备份再删，历史价格不默认删除；不为凑满 3 条接纳错型号。当前为 19/19 品、60 条链接；2026-11-08 新增 TPMS 2只装的1只/4只竞品仅作市场参考，尚无新快照且不参与直接比较。`MAR-YAM-67F-02` 的 3 条归档映射已删，114 条历史价格保留；另 6 条 404/聚合旧链接已删，200 条历史价格保留。
- **缺失不是零**：`rating=NULL` 是未知，不能按低分或 0 分处理；真实 `reviewCount=0` 与评分未知可并存。价格有效仍保存，评分缺失不再丢价格；缺任一评分不伪造完整均值。数据库 `price` 保留展示价，`price_regular` 单列常规价且双精度存储，新精准快照必须为 `price_type='regular'`；旧 `legacy_unknown` 只作历史展示、不推测回填、不参与直接比较。竞品快照新鲜度 24h 且禁未来时间，历史比较按时间找前一批，不按固定行数偏移；补跑按快照保存真实回执，`UNCERTAIN`先对账不自动重传。`pending-reconciliation.json` 在每次 POST 前先保存完整上传意图，成功回执或 API 精确回读匹配后才清除；未解决意图整链阻断，普通全量与补跑都不得绕过。账本未成功加载不得写回，对账失败或映射已删不得静默清除。dry-run/子集不覆盖正式`latest.json`，排除项仅留报告不上传。
- **可比性分层与评分补取**：`data/competitor-scans/competitor-comparability.json` 按 `offerId + competitorUrl` 标记 `direct_comparable / market_reference / pending_verification`，只有第一类的有效常规价快照进入价格比较；其余保留映射、报告与历史，不删除。新链接默认待证且不上传。补跑先加载最新配置再重打携带行标签，升级直接可比且未保存者重抓，降级者不得继续比较。消费端 API 只放行当前明确直通的非空 URL，历史聚合与降级快照仅供对账。主通道缺评分时可用 `channel:"direct"` 补取；直连页必须具备正确 SKU、有效价格和真实数值评分才可替换整行，失败或原页无数值评分保留 NULL。每轮直连失败后跳过本项后续补取并明示原因，不反复等待或覆盖有效翻译通道数据。
- **周复盘分两层并跨会话执行**：服务器每周一 03:28 UTC 生成真实经营快照；本机 Windows 系统任务 `ONZO Weekly Review` 每周一 14:41（本地）以 S4U 运行 `scripts/run-weekly-review.ps1`，经 `scripts/weekly-review-runner.mjs` 调用 Astra、Antigravity Opus 5.5 High（`scripts/antigravity-run.mjs`，写 `opus.json`）、Gemini 4 Argon HIGH，再由 Kimi API 最终整合最多 3 项行动。正式调度不依赖 Kimi 会话或会话 Cron；旧会话任务 `01M735EZ33KK15Q9E5ATQHNG75` 已于 2026-11-11 在系统任务实跑成功后删除，`CronList` 为空是正常状态。模型实际档位与模型名只按每次回执记录；Astra 使用已验证的 Git Bash 绝对路径 `C:\Program Files\Git\bin\bash.exe`（允许 `GIT_BASH_PATH` 覆盖），每次保存 `astra-process.json` 的 stdout/stderr/退出码，禁止在 S4U 环境依赖裸 `bash`。Opus 失败保留真实原因，不降档或用 Terra 冒充；2026-11-11 系统代理关/开对照均为相同地区资格拒绝、0 turns/0 tokens，不能归因为单纯未开系统代理，也不得绕过资格限制。按最老直接可比快照判断 24h 新鲜度，同时校验 source 的 `collectedAt`、独立 `last-run.json`、失败计数、过滤条件、未来时间和待对账项；缺失、fatal、dry-run、子集或 latest 未推进均不得沿用旧健康报告。Kimi 原文先落盘再解析，失败保留上一份成功报告；`--resume` 只复用冻结输入和已有评审文件并重跑最终整合，不重跑其他模型。详见 `docs/operations-manual.md` 第十节。模型只读分析不碰生产；本机离线仍可能漏跑，恢复后必须核查实际任务与报告，不伪称完成。日常桌面任务、代码与视觉理解使用 Antigravity Gemini 4 Hydrogen High；周复盘现使用 Astra、Opus、Argon，Opus 已于 2026-11-14 经真实回执恢复；历史 Carbon 文件继续按原模型恢复，不与 Opus 改名或混用。
- **Direct 只读自动报表**：Windows 任务 `ONZO Direct Daily Report` 每日 11:20（本地）运行 `scripts/run-direct-report.ps1`，用本机既有 ONZO Ads Manager 令牌只读 Reports，输出 `temp/direct-reports/latest.json`（滚动30天、最近7天/前7天、逐日数据）；令牌不传服务器、不打印。2026-11-11起同时覆盖 `715426752` 与新campaign `716088179`，`byCampaign` 分别汇总；顶层 `campaignId/currentDay/last7Days/previous7Days/rolling30Days` 仅保留主campaign 715 的兼容口径，不得混算。新campaign `hasReportRows=false` 是当前无报表行，不证明审核或投放为0。`weekly-model-prompt.py` 默认自动携带该文件及 SHA-256；当前 UTC 日单列，完整周窗口截至昨天，0 转化时实际 CPA 不可计算，Direct 与 Ozon 原生广告分开。失败写 `last-error.json` 并保留旧报告，周复盘将超过 36 小时的报表标为陈旧，不伪造 0；本机/会话离线不得伪称采集或复盘完成。marketplace 设置不通过 API 修改。
- **经营风险独立过闸**：`GEN-BELT-35X1126-01` 的历史亏损不得只当字段异常，也不能借竞品整改擅自改价；2026-10-27 已按用户授权完成 P0 止亏调价，见下节。`PROMO_AUTO_DECISION=false` 保持不变。2026-11-11用户明确授权按完整方案执行后，`715426752` 已停损停止且不定时恢复；新campaign `716088179` 仅含 `GEN-BELT-33X14-01`/SKU `5900476661`、俄罗斯、CPA 3.5美元、周预算35美元、预算上浮关闭，回读已为活跃且审核中提示消失。不得据此自动扩品、加预算或承诺出单；7天或5单先到复盘，后续调整仍需逐项核验与授权。证据 `temp/direct-carbon-20261111/execution/execution-result.json`。

## Ozon 搜索查询本机降级（2026-11-09 生产实证）

- **采集边界**：官方免费搜索查询 API 与导出受会员限制；云端标准 Chromium 访问 Seller 实测 403。MPSTATS 官方 API 只作外部市场热度/竞争补充，不能替代 Seller 原生转化指标。本机真实 Chrome 通过正常翻页捕获 `POST /api/site/searchteam/Stats/queries/search/v2` 的当次会话上下文；不导出 Cookie/敏感请求头，不绕过验证码、MFA、风控或会员限制。Seller 标签页需激活后加载，当前页以 `data-selected/disabled` 识别，未加载不得写成 0。采集依赖本机 Chrome 登录态，不声称云端无人值守。
- **真实数据与口径**：原生 7 天完整批次 `2026-11-09T04-10-23-926Z` 为 199 页、9,942 条，SHA-256 `ee29ab5653863691c0ffc93f1794d0bf0a3b761662923b17853b9cdceb8892e5`。这是市场查询，不是本店 SKU 漏斗；动态 28/7 保持 `NULL`，原始 `avgCountItems` 不作语义猜测。滚动 7 天不能直接相加，28 天只用四个不重叠周窗口；独立买家不去重相加，未确认指标不盲算。接口未返回自然日边界/时区，不冒充官方 28 天或季节性。
- **生产与定时任务**：提交 `955c6b3b`、`18d1b077` 已推送并部署，验收提交 `16547752` 已同步且 `/ready` 通过，正式 HTTPS ingest 将 199 页、9,942 条写入 PostgreSQL，逐行 JSON、原始回执和 SHA-256 全部一致，重复导入幂等。正式页面为 `https://huashangshangmao.top/search-analytics`，已用真实登录态验收首屏、筛选、趋势、28 天提示及导出。Windows 任务 `ONZO Ozon Search Analytics` 每日 13:47 运行，2026-11-09 14:24 首次实跑返回 0，批次 `2026-11-09T06-24-05-227Z` 已入库；直接复跑 `2026-11-09T06-29-08-976Z` 也成功。下一次调度回读为 2026-11-10 13:47，不能把首次成功当成永久无人值守。独立密钥仅置于权限 600 的 `data/secrets/search-analytics.env`，不读写现有 `.env.production`，不传模型。全项目 80 个测试文件 774 项通过，构建通过，Lint 0 errors。操作与排障见 `docs/operations-manual.md` 第九节，知识条目 `pb_ozon_search_query_local_fallback_20261109` 已入库并命中第一。`PROMO_AUTO_DECISION=false`、商品价格库存及广告未因此改变。

- **失效标签页恢复（2026-11-10）**：2026-11-10 13:47 定时采集因 `No tab with given id 203942741` 失败，旧成功数据未覆盖。采集器每轮先 `close_session` 清理自己创建的任务页，再新建并激活 Seller 页面，使用当前页码按钮和真实指针翻页取得原生 7 天请求；成功后清理，失败保留任务页供核查，借用用户页面不关闭。修复后实跑 `2026-11-10T15-02-05-470Z` 为 199 页、9,945 条，`LastTaskResult=0`，下一次回读为 2026-11-11 13:47，正式页面失败告警已消失。Node 直接写 UTF-8 日志，PowerShell 只启动并传退出码，旧日志另存 `.legacy` 保留。知识 `pb_ozon_search_tab_recovery_20261110` 须走正式门禁，不手写 SQL。

## 在售品止亏调价与生产回读（2026-10-27 实证）

- **成本按实际通道重算**：不能只用较低的 OGL 费率覆盖 CEL 仓，须按实际仓库/线路/货值/计费重量分别核价并保守取高；`acquiring` 是金额，不是全店统一百分比。CPO 须读取实际活动及成员，不能凭活动名称推断费率。35X 本次采用采购 120 CNY、供应页 600g（非实测）、CEL Standard Small 41.55 CNY、17%佣金、0.33%国际运输、5%退货预留、2%电子服务及1%收单/结算预留；固定成本2013.5895₽（FX=12.09）。
- **生产验收不是 `updated=true` 就结束**：先备份价格、活动和库存，写后同时回读 `price/min_price/old_price/marketing_seller_price`、活动成员与库存；字段异步同步，不能以部分字段成功或一页缺席代替完整验收。`min_price` 不保证叠加优惠不破底，数量折扣与前台银行渠道价分别核验，银行优惠价不等于卖家收入。`PROMO_AUTO_DECISION=false` 不得擅自开启。
- **促销退出与失败恢复**：只操作目标SKU，完整分页核对其他成员未变。若原活动价已超当前准入限额，退出后不得承诺能重新加入；失败时保留最近已验证的一致价格状态，不盲目重试或强写库存。绑定货源接口可能用默认值覆盖原空字段，必须备份并逐字段回读；本次35X映射仅把450g估值更新为供应页600g，未采用未确认的110元货源，原`freight_address`与供应商均保留。
- **当前结果边界**：35X `product_id=6459038517` 已退出弹性提升，`base/min_price=259 CNY`、`old_price=276 CNY`；FBS/rFBS各25、预留0未改，数量折扣未激活。按上述假设估算利润324.559677₽/单、净利率10.364981%，不是已结算利润或销量保证。实际包装重量、尺寸、1126/1133测量口径与供应变体仍须拿样/厂家确认，不宣称商品合规或实物参数已验收。证据与脚本见`temp/ops-exec/p0-35x-*20261027*`及`docs/current-pipeline.md`第九节。
