# ONZO 当前链路状态（2026-07-23 快照）

> 本文档记录**当前实际跑通**的链路与配置，与 `architecture.md`（设计目标）区分。
> 目的：任何新会话/新人只读本文 + `deployment.md` 即可接手运营，不依赖历史对话。
> 状态变更后请同步更新本文。

---

## 一、上架链路闭环（已全线跑通，均实测验证）

```
选品（季节因子接入 finalScore）
  → 飞书 listing 命令触发
  → 1688 素材抓取（本机 WebBridge 工具，见第四节）
  → AI 文案营销化 + 定价拆解（定价明细随通知发出）
  → Ozon API 上架
  → import-status-sync 回填真实 product_id（采购匹配的关键闭环）
  → Webhook 事件驱动出单（/ozon/webhook → ozon_webhook_log → drain 消费）
  → 采购匹配（凭 product_id 关联 1688 货源）
```

关键提交（可回溯实现细节）：

| 环节 | Commit | 说明 |
|---|---|---|
| 选品季节因子 | `258d860` | 季节因子计入 finalScore |
| listing 断链修复 | `068dc5a` | 飞书 listing 命令链路修复 |
| product_id 回填 | `3965a2a` + `f466caf` | 实测 task_5164731660 → product_id 5601249994 |
| 文案/定价通知 | `05632a5` | 文案营销化 + 定价拆解随通知发出 |
| 1688 素材工具 | `2d8e812` | `scripts/download-1688-assets.cjs` |

Webhook 架构细节见 `webhook-architecture.md`。Webhook URL `https://huashangshangmao.top/ozon/webhook` 已在 Ozon 卖家后台登记成功（注意：登记校验要求响应体符合 Ozon 模板格式，已实现）。

## 二、飞书双机器人（已可用）

- **ops-agent（运维）** 与 **promo-agent（推广）** 是两个独立飞书 App，消息带 `[运维]` / `[推广]` 前缀以区分来源。
- 群聊中 @ 机器人才会响应（私聊直接响应）；chatId 配置于服务器环境变量，不写进仓库。
- 凭据（App ID / App Secret）仅存于服务器 `.env` 与本地 `.env`，**任何文档/代码中不得出现明文**。

## 三、自动部署（deploy-watch）

详见 `deployment.md` 的 deploy-watch 一节。要点：

- 服务器 cron 每 5 分钟检测 `origin/main`，有新 commit 自动构建部署。
- **不要并行手动 `docker compose build`**——与 deploy-watch 的构建并发会撞坏 buildkit 缓存（已发生两次）。构建统一走 deploy-watch，或确认其空闲后手动执行。

## 四、1688 素材抓取（本机工具）

脚本：`scripts/download-1688-assets.cjs`

```bash
node scripts/download-1688-assets.cjs <1688链接或offerId> [输出根目录]
```

- **前提（缺一不可）**：用户本机 Windows；Kimi WebBridge daemon 运行于 `127.0.0.1:10086`；Chrome 扩展已连接。
- **流程**：打开商品页 → 滚动触发懒加载 → 页面内提取标题/价格/规格/全图/视频 → 带 Referer+UA 下载 → 生成 `manifest.json` 采购清单（原始 URL + 本地路径 + 规格参数，供出单后采购使用）。
- **输出**：`D:\下载\1688_<offerId>\{images,videos,manifest.json}`。
- **实测基线**（offer/891784406688，2026-07-27 增强后）：图 **34/34（100%）**，视频 2/2，规格 22 条，标题干净。增强点：慢滚回顶触发懒加载；`background-image`/`srcset`/HTML 数据层视频扫描；alicdn 缩略图后缀（`_60x60q90`/`_sum`）还原原图；空 Referer 防盗链兜底；广告噪声（`gg_dtc`/`tps-*`）过滤；失败 URL 记录于 `manifest.failures`。
- **为什么不做成服务器端点**：WebBridge 运行在用户本机，服务器 api-services 无法触达。如需飞书触发，只能"服务器下单 → 本机跑脚本"两段式。
- **为什么不用官方"1688采购助手"插件弹窗**：其下载弹窗为 hover 触发 + 跨域 iframe + isTrusted 检测，自动化无法稳定展开，已放弃该路径。

## 五、已知未决项（不影响主链路，按需处理）

- 飞书触发素材抓取的两段式串联（未做，需求待确认）。

**选图分辨率硬门槛（2026-07-29 教训，主图 124×220 被拒两次）**：①素材必须先用 `scripts/filter-images.py` 审计尺寸再选——**≥800px 直接用，400–799px 仅副图，<400px 一律弃**；②1688 评价区/买家秀图普遍 124–220px（img_13/14 这类），绝不可作主图；③下载后尺寸不足的图**不要靠放大救**（放大=模糊），改走"卖点提炼俄文重制"路线（PIL 信息图模板）；④主图优选：白底/浅底产品全貌 + 差异点可见（如数显屏）。

已关闭（2026-07-23 核实）：

- ~~素材图成功率低（13/26）~~ — 2026-07-27 增强后达 34/34（100%），详见第四节基线。

- ~~`transition-logistics.test.ts` importBilling 超时~~ — 复跑 14/14 全部通过（2.1s），不再复现。
- ~~Ozon 测试商品清理~~ — 店铺活跃商品 0；11 个测试商品（SKU-HSR-*/SKU-NOBRAND/WarmDesk-DF5E 等）全部处于归档态（Ozon 终态，前台不可见，Ozon 不支持物理删除已创建商品）。
- 注意：`listing_records` 回填过的 product_id 5601249994 在 Ozon 已查无此商品（既不在活跃也不在归档）——个别回填 id 可能失效，采购匹配遇 404 时按无货源处理即可。

## 六、首个真实商品上架（2026-07-27，已"在售"）

商品：车载磁吸支架（1688 offer 891784406688）｜offer_id `HS-XP2-MAG-01`｜product_id `5683403180`｜SKU `5233533151`
类目：Автотовары > Автоаксессуары > Держатель автомобильный（cat `17028749` / type `115950474`）
状态：后台"在售"；CEL陆运仓（`1020005021424150`）库存 20；价格 99 CNY / 划线 245 CNY（前台 ≈1210₽/2990₽）；图 8 张（1920 原图，无中文）；属性 24/39。

**复用经验（下次上架直接照用）**：

1. 店铺合同币种 **CNY**（`/v1/seller/info` 可查）：价格必须 CNY 提交（`currency_code:"CNY"`），Ozon 前台自动换 RUB 展示；传 RUB 报 `currency_differs_from_contract`。
2. v3 import 字段：`weight` 为 **int32（克）**；depth/width/height 为 mm（int）；`vat:"0"`；`offer_id` 必填 ≤50 字符；`type_id` 必填（类目树叶子）。
3. 仓库分两型：FBP（Ural/GUOO，库存不可 API 手动更新，需入库流程）与 rFBS（CEL 系，`/v2/products/stocks` 可设）。**`errors:[]` 即成功，勿当失败重试**（曾因打印 bug 重复设库存致 4 仓各 20）。
4. 图片：alicdn 原图 URL 直传最简（后缀 `_WxH`/`_sum.jpg`/`_.webp` 全部剥掉），约 7/8 成功率；失败补 `/v1/product/pictures/import`（需 product_id，创建后才能用）。upload.ozon.ru 已废弃（NXDOMAIN）。
5. 商品状态查询：`/v3/product/info/list` 对单商品查询不友好（400/空），用 `/v1/product/import/info {task_id}` 查导入/更新任务，或直接卖家后台。
6. 内容评级：初值 34.5（属性 11/39）；补到 24/39（含 Аннотация 短描述、#Хештеги、特性字典、产地、保修）。评级每日重算，次日复验。
7. ~~Rich-контент JSON（attr 11254）两次被模板拒绝~~ → 已解决：按**官方 schema**（`assets/ozon-rich-schema.json`，来自 rich-content.ozon.ru/docs）组装。三个必踩坑：①顶层 `{content:[...], version:0.3}`（不是 0.4）；②块用 widgetName（raShowcase/raTextBlock/raVideo/raTable/list），不是 blockName+type；③**img 必须全尺寸五字段**（src/srcMobile/width/height/widthMobile/heightMobile，缺 srcMobile 必拒）；src 必须用**完整可下载 URL**（商品已上传图的 Ozon CDN 地址 `https://ir-20.ozonstatic.cn/s3/multimedia-*/….jpg`——相对路径会被判"不完整链接"，外链域名同理可用来过渡但 CDN 最稳）。**提交前必跑本地校验**：`node scripts/validate-rich-json.cjs <json>`（ajv + 官方 schema，示例 `assets/ozon-rich-example.json`）。富内容不计入内容评级分，作用是提升转化率；提交时机：商品"在售"稳定后。
8. 视频：API 无公开上传接口（21841/21845 属性只接受 Ozon 视频 id）→ 卖家后台手动传，本地视频在 `temp/listing-staging/`。
9. 前台索引有延迟（数小时~1 天）：后台"在售" ≠ 前台立即可见。

脚本（temp/，流程跑通后可固化）：`ozon-api.cjs`（API 客户端）、`ozon-list.cjs`（创建）、`ozon-enrich.cjs`（属性补全）、`listing-payload.json`（文案/定价/素材清单）。

10. 图片公网 URL 链路：`POST /api/image/upload`（X-API-Key 头）存 api 容器 `./data/images`，生成 `/images/{uuid}.jpg`——**必须有 Caddy HTTPS 路由**（`8e235ad` 修复，此前落 SPA 返 HTML，Ozon 拉图失败报"无法通过链接下载照片"）。⚠️ `IMAGE_STORAGE_PATH` 未挂卷，**api 容器重建后历史图片全丢**（新传不受影响）。
11. 商品图片三错误根因：主图 alicdn URL 实际返回 webp 内容 → Ozon 拒收（"无法接受这种格式"）+主图顶替+下载失败。**一律本地转 JPG → 传服务器 → 用服务器 URL**；`pictures/import` 最新成功的一张会自动成为主图。
12. 视频自动化链路（已固化）：`scripts/make-video-ru.py`（去中文音轨+烧俄文字幕，ffmpeg/libass）→ `scripts/upload-ozon-video.cjs`（WebBridge 操作卖家后台）。**两条上传路径**：默认媒体 tab 路径（列表 → SPA 内 `location.assign` 到 `/edit/general-info` → 媒体 tab →"添加视频"→注入→保存）；`--rating` 评级面板路径兜底（列表→评级按钮→面板内上传）。关键坑：①后台 tab Chrome 节流连骨架都不渲染，navigate 后必须 CDP `Page.bringToFront`；②骨架屏也有"商品编辑"标题，就绪判断要看"类目和类型"表单字段；③铅笔是 target=_blank 开 session 外新 tab，WebBridge 接管不到，须用 SPA 内跳转；④点击媒体 tab 可能不切 URL，需 `location.assign` 直达保底；⑤文件路径用正斜杠；⑥上传后必须点"保存"，关页未保存则丢失。媒体 tab 页还有"添加图片/视频封面/富内容"入口，同法可扩。

## 七、平台规则情报（2026-07-28 Ozon 公告）

- **商品合并规则（强制）**："型号"合并仅限同款的尺寸/颜色/容量变体；功能形态不同的商品（如磁吸款 vs 夹持款）不得并入同一型号组，应分建商品卡用"相似商品"关联。违规有 7 天修正期，系统性违规暂停全部商品组展示。9048 型号名保持店铺内唯一值（防误合并+防虚假分组，现做法已合规）。
- **评价积分（2026-07-30 后台实证）**：磁吸支架"快速收集评价"已开启（发布时勾选即默认开启；位置：商品编辑页第 4 步预览 →"付费推广"板块）。单价 **250₽/条**（用户确认）。官方 7/27 通知原文证实：**2026-08-04 起停发评价积分、下架徽章**（定价 Agent 的"立规"说不成立）；替代激励=精选集提位/主页邀评提示/下单后推送，出单后主动引导评价更重要。

## 八、安全备忘

## 九、当前工作状态（交接快照 2026-08-07，供新会话衔接）

### 在售商品（8 个，全部命中选品公式：型号门槛+本土无品牌墙+中国供应链）
| offer_id | product_id / sku | 商品 | 价格 | 状态 |
|---|---|---|---|---|
| GEN-CARB-168F-01 | 5871489256 / 5393398726 | 发电机双燃料化油器 168F/170F（LPG/NG+汽油，2-3kW） | 216.5¥（~2490₽） | 8/7 上架，库存 25，图 8+富内容+轮播视频，毛利 52-58%。**28 天官方数据 356 单/152 万₽**——应急电源爆发赛道，全店最硬 |
| MAR-YAM-61N-01 | 5795139207 / 5328928186 | 船机化油器修理包 61N-W0093-00（Yamaha 25-30HP T30） | 146.9¥（~1690₽） | 8/3 上架，库存 30，图 8+视频+富内容，毛利 43-48%，质检 PASS 8/8。**8/10 全店首单（1 件），8/11 买家取消——漏通知事故，见下节** |
| MAR-COVER-S / MAR-COVER-M | 5768382441 / 5768382343 | 船外机保护罩 210D（S≤15HP / M 15-30HP） | 199.1¥ / 216.5¥ | 8/1 上架，库存 30/50，双独立卡（类目无尺码变体维度，O13 坑），毛利 53-63%。**9-10 月封航季主力** |
| MAR-YAM-6E7-01 | 5764460511 / 5302493207 | 桨毂衬套 6E7-45987（Yamaha 9.9-20hp 2T） | 199.1¥（~2290₽） | 7/31 上架，库存 25，毛利 48.7%，评级 100 |
| CN-HAV-H6-DOOR-01 | 5764460660 / 5302498432 | Haval H6 门锁拉线 6105109XKZ16A | 112.2¥（~1290₽） | 7/31 上架，库存 100，毛利 42-47%。**警报：出现 FBO 竞品 1243₹/28 评，价格承压** |
| MAR-YAM-67F-01 | 5753404525 / 5293276687 | 67F 水泵叶轮（F75-F100 4T 副厂） | 112.2¥（~1290₽） | **⚠️ 8/5 商标侵权停售（标题含 Yamaha）——已去品牌词救火（4180/4191/富内容 9 处清零），审核中**。恢复后 CPC 重开（平均 CPC ≤15₹） |
| HS-XP2-MAG-01 | 5683403180 | 车载磁吸支架 | 99¥ | 清货（-3% 促销至 8/14，活动 4127830），CPC 已停 |
| HS-MOTO-6CLAW-01 | 5720833147 | 摩托气囊支架 | 52¥ | 纯自然流清货 |

**已归档**：PET-DOG-BOOTS-01（狗靴，5827253559）——雨鞋≠冬季保暖定位错位+无试穿图，用户判归档（pitfalls S5）。

### 订单通知链路（2026-08-12 事故与修复）

**事故**：8/10 11:28（北京）61N 出首单（0148010868-0049，1 件），无任何提醒；8/11 20:49 买家取消。排查证实通知链路**从未真正工作过**，四重断裂：①Ozon 推送**不带 X-Ozon-Signature 头**（实测），接收器 `webhook.route.ts` 对无签名请求静默 200 吞掉，零落库（ozon_webhook_log 7 天 0 行）；②Ozon 真实报文字段是 `message_type`/`order_number`/`uuid`，与解析器期望的 `event_type`/`posting_number`/`event_id` 完全不匹配；③`notifier.ts` 只支持企业微信/Telegram，**无飞书渠道**，且服务器未配任何 `NOTIFY_*` 变量；④5 分钟兜底同步抓到单也不发通知。另：静默时段 UTC 22-07 = 北京 06:00-15:00，白天 info 级通知全被吞。

**修复（commit `937b5ff` + `ea0b250`，已部署并端到端验证通过）**：
- `packages/ozon-order/src/webhook.ts`：兼容真实报文（message_type→事件映射表、uuid 幂等、order_number、new_state）；TYPE_STOCKS_CHANGED/类目树等非订单事件标记 `ignored` 不落库；TYPE_NEW_MESSAGE→买家消息通知。
- `webhook.route.ts`：无签名不再静默吞；伪造防护改为 **seller_id 白名单校验**（对 OZON_CLIENT_IDS）+ 可选 `OZON_WEBHOOK_IPS` IP 白名单；有签名仍验签。
- `webhook-drain.ts`：新单按 `order_number` 调 `/v3/posting/fbs/list` 拉真实包裹（含 `-1` 后缀）聚合商品/金额；拉取失败降级 minimal payload 仍发通知；买家消息触发通知。
- `notifier.ts`：新增**飞书自定义机器人渠道**（`NOTIFY_FEISHU_WEBHOOK` + `NOTIFY_FEISHU_SECRET` 签名校验，已配置并实测收发成功）；`force` 标志真正生效（此前被忽略）。
- `notification-events.ts`：ORDER_NEW/ORDER_CANCELLED/BUYER_MESSAGE 均 `force: true`（突破静默时段）。
- `ozon-order-sync.ts`：兜底同步发现新单/取消单也发通知；与 webhook 路径**双向防重**（order_number ↔ 带后缀 posting_number 前缀匹配，先到者通知）；同步错误内容打日志。
- 测试：ozon-order 23 + api-services 相关 15，共 38 全过（含 6 个真实报文格式用例）。

**部署中追加发现的两个隐藏故障（同批修复）**：
- **定时任务调度器 leader 锁断裂**：`redis-lock.ts` 的 extendLock 依赖 `cache.getClient()` 执行 Lua 续约，但 `getClient` 只是 cache 包模块私有函数、从未挂到单例上 → 续约永远失败 → leader 身份每 30s 丢失，60s 任务 tick 与 30s leader 窗口谐振后**drain/订单同步等全部定时任务在容器重建后永久落空**。修复：`RedisCache` 类暴露 `getClient()` 方法（commit `ea0b250`）。
- **`order_id` INTEGER 溢出（8/10-8/11 sync 154 次 errors:1 的真凶）**：Ozon order_id 为 11 位数（38394336004）超 PG int4 上限，sync 拉到订单后 INSERT 直接失败——这就是"凭据正常、API 正常但永远 0 单"的原因。修复：`local_orders.order_id` / `ozon_orders.order_id` / `purchase_1688.ozon_order_id` 三列改 BIGINT（schema.ts + 生产库已 ALTER）。8/10 首单已手动补录进 ozon_orders（cancelled 态）。
- 教训：**job 报错必须带内容**，只记数量的日志等于没有日志。

### 广告与促销
- **CPC 两次实证止损**（学费 842₹）：磁吸 33706085（CPC 57₹）+ 67F 33938265（CPC 43₹，728₹/0 单）。**铁律：自动策略 MAX_CLICKS 对窄品类长尾件出价失控，冷门件零评价期不投 CPC；正确形态=平均 CPC 策略 ≤15₹（保本线内）**。重开条件：67F 审核恢复 + 任一 SKU 出单有评价。
- **破零促销在跑（均"我正在参与"）**：磁吸 4127830（至 8/14）、67F破零（至 8/16）、61N 4154063 + 6E7 4154141（8/6-8/19）。
- **CPS**：新品期不可用（需 14 天 1 单）。**评价积分 8/4 已停发**——邀评靠平台原生推送。
- **WOW 大促（9.25-10.15）**：9/3 报名检查提醒（cron a9931c5e），7 SKU 全符合 60 天新品免门槛。
- **Yandex 站外**：未充值，暂停。

### 选品公式（实盘验证版，后续扩品统一按此）
**四重验证全过才上架**：①趋势/需求数据（官方 28 天搜索查询+销售榜）②竞争验证（Ozon 实时搜索页：避开本土 FBO 品牌墙/评论池垄断）③1688 货源（成本/起批量/跨境专供/素材干净度）④单元经济（毛利≥40%，售价≥800₹ 物流铁律，≤500g/≤60cm，CEL Extra Small 价≤135¥ 超出走 Small 仓）。
**放宽（8/5 定稿）**：不强制型号门槛——可与 rFBS 跨境同行竞争（打机翻/搬运图）；优先"已动销+中国供应链+利润可观+未来刚需"。**买点证据链两问必答**（凭什么转化/需求定位一致吗——狗靴 S5 教训）。
**永久黑名单**：通用卡扣/LED 灯泡/普通雨刮/机滤/汽车通用火花塞/平衡杆胶套/三滤/刹车/转向/气囊/喷油嘴/氧传感器/高压传感器/220V 带电/液体/粉末/易碎/大件。
**标题红线**：**禁含他人品牌词**（Yamaha/Haval 等——67F 侵权停售实证；副厂件用"аналог+OE 件号"表述，OE 件号不是商标可用）；hashtags 同禁。

### 关键工具（全部固化可用）
- 采集：`temp/auto-scan.cjs`（Ozon 搜索页批量筛查，13 词 2.5 分钟）、`temp/src1688-scan.py`（1688 搜索+商品页，GBK 编码）、`scripts/download-1688-assets.cjs`、`scripts/filter-images.py`、`temp/wb.py`（WebBridge 通用 POST 助手，请求文件方式防转义）
- 制作：`temp/make-carousel-videos.py`（轮播视频生成，含 67F/6E7/door/boat-cover/carb-kit/gen-carb 六套 config）、`temp/listing-*/build_images.py`（各品信息图脚本）
- 上架：`temp/ozon-api.cjs`、`temp/ozon-list-*.cjs`（建品模板）、`temp/upload-frames.mjs`、`scripts/validate-rich-json.cjs`
- 广告：`temp/perf-api.cjs`、`temp/cpc-monitor-33938265.cjs`（campaign 监测）
- **WebBridge 要点**：daemon 卡死用 `kimi-webbridge.exe stop→start`（PID 残留删 ~/.kimi-webbridge/daemon.pid）；链接 slug 尾号用 **sku 不用 product_id**（O11）；session 失效换新 session 名；后台操作 CDP 真实点击+JS 写文件再 evaluate。

### 活跃 cron 任务
| id | 时间 | 内容 |
|---|---|---|
| a9931c5e | 9/3 10:47 | WOW 大促报名检查（7 SKU 免门槛） |

### 下一步待办（按优先级）
1. **67F 审核恢复** → 立即重开 CPC（**平均 CPC ≤15₹，绝非自动策略**），先小预算 1000₹/周验证 CPC 是否 ≤15₹
2. ~~首单盯梢~~ → **首单已发生并流失（8/10 61N，通知断链）**；通知链路已修复（见上节）。后续：每日看订单+问答区（Вопросы-ответы）；任一 SKU 出单→评价积累→按公式扩该赛道型号矩阵（叶轮其他马力段/艇罩大码段 60-100HP/化油器包其他件号/拉线配对侧 6105108XKZ16A）
3. **9/3 WOW 报名**（提醒已设）；双 11/黑五节奏按 dim09 计划第 8 章日历
4. **拉线价格战监控**：FBO 竞品 1243₹/28 评——若持续压价，评估降价跟进或让出
5. **多站点分发评估**（哈/白俄物流 -40%，dim09 计划 5.4 节）——同 Listing 同步，零边际成本增量

### 用户偏好（必须遵守）
- 主 Agent 与子 Agent 思考链路、全部交流**统一中文优先**
- **Agent 集群模式**：选品/调研/质检派专业子 Agent 并行；主 Agent 只做采集（浏览器/API 直跑）、任务分发、总结+建议。**浏览器采集主 Agent 直跑，禁派子 Agent 碰浏览器（会卡）**
- 选品全自动执行不弹窗请示；CPC 修改类动作（暂停/预算/出价）先报用户确认
- 流程：选品数据验证→子 Agent 交叉分析→复核→总控上架→质检验收
- **禁裁剪中文供应商图**；素材不足走俄文信息图重制（同模板 ≤2 张防判重）
- 评级重算 ~5 分钟；补图后等 ≥10 分钟管线稳定再判真实图数

- 以下凭据曾在即时通讯中明文传输，建议择机轮换：Kimi K3 API Key、飞书 App Secret、Ozon API Key。
- 服务器 API_KEY 已在换服务器时轮换过一次（值存于服务器 handover 文件，未进仓库）。
