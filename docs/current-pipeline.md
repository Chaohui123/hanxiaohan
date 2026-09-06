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

### 在售商品（9 个，全部命中选品公式：型号门槛+本土无品牌墙+中国供应链）
| offer_id | product_id / sku | 商品 | 价格 | 状态 |
|---|---|---|---|---|
| MAR-YAM-66T-01 | 5980014152 / 5486165368 | 化油器修理包 66T-W0093-00/01（Yamaha 40X/E40X 2T 40HP） | 146.9¥（~1812₽） | **8/16 上架（选品→视觉→建品全自动化首跑）**，库存 25，图 8+富内容（待补），毛利 75.5%/净利 38.9%，底价 1063₽。货源亚玛瑞 ¥36（回头率45%）。FB_ORIGINAL 救火：4191 禁"не оригинальная"（O10 实证否定句也拦）；材料属性须字典值（5309 手写字符串 warning） |
| MAR-YAM-6E5-01 | 5984359936 / 5489986970 | 化油器修理包 6E5-W0093-06-00（Yamaha V4/V6 115-130HP，双化油器机型一次 2 套） | 146.9¥（~1812₽） | 8/16 上架（全自动化第三件），库存 25（CEL陆运3），图 8+富内容，**毛利 85.7%/净利 49.1%（全店最高）**，底价 800₽。货源福鼎双泰 ¥21（回头率43%）。素材中文水印横带逐列均值填充处理（过渡列填带下缘色防竖条） |
| GEN-CARB-168F-01 | 5871489256 / 5393398726 | 发电机双燃料化油器 168F/170F（LPG/NG+汽油，2-3kW） | 216.5¥（~2490₽） | 8/7 上架，库存 25，图 8+富内容+轮播视频，毛利 52-58%。**28 天官方数据 356 单/152 万₽**——应急电源爆发赛道，全店最硬 |
| MAR-YAM-61N-01 | 5795139207 / 5328928186 | 船机化油器修理包 61N-W0093-00（Yamaha 25-30HP T30） | 146.9¥（~1690₽） | 8/3 上架，库存 30，图 8+视频+富内容，毛利 43-48%，质检 PASS 8/8。**8/10 全店首单（1 件），8/11 买家取消——漏通知事故，见下节** |
| MAR-COVER-S / MAR-COVER-M | 5768382441 / 5768382343 | 船外机保护罩 210D（S≤15HP / M 15-30HP） | 199.1¥ / 216.5¥ | 8/1 上架，库存 30/50，双独立卡（类目无尺码变体维度，O13 坑），毛利 53-63%。**9-10 月封航季主力** |
| MAR-YAM-6E7-01 | 5764460511 / 5302493207 | 桨毂衬套 6E7-45987（Yamaha 9.9-20hp 2T） | 199.1¥（~2290₽） | 7/31 上架，库存 25，毛利 48.7%，评级 100 |
| CN-HAV-H6-DOOR-01 | 5764460660 / 5302498432 | Haval H6 门锁拉线 6105109XKZ16A | 112.2¥（~1290₽） | 7/31 上架，库存 100，毛利 42-47%。**警报：出现 FBO 竞品 1243₹/28 评，价格承压** |
| MAR-YAM-67F-02 | 6017235420 / 5518383300 | 67F 水泵叶轮（F75-F100 4T 副厂） | 112.2¥（~1290₽） | **8/18 换品重建已在售**：旧品 67F-01（5753404525）侵权下架根因=**3 张信息图含 Yamaha**（文本 8/5 已清、图没清）——用户拍板归档，新图重制（马力段 75-100 л.с. 替代 F 型号/Yamaha，OE 件号保留），库存 30，mapping+3 竞品链接已迁，官方竞品链接已提交审核 |
| HS-XP2-MAG-01 | 5683403180 | 车载磁吸支架 | 99¥ | **8/18 归档**（无备货/无利润/无竞争力，用户判归档） |
| HS-MOTO-6CLAW-01 | 5720833147 | 摩托气囊支架 | 52¥ | **8/18 归档**（同上） |
| MAR-ICE-BLADE-01 | 6022473057 / 5522803772 | 冰钻替换刀片 130mm 一对（不锈钢弧形） | 23¥ | **8/19 上架在售**（秋冬冰钓赛道首发），182.2¥/2290₽，破零价 1990₽，库存 50，净利 54.3%。28 天榜单早鸟验证（Boashi 9 件起量类目空白），11 月旺季收割 |
| MAR-BAITBOAT-01 | 6022474348 / 5522804641 | 智能打窝船 V803（500m 遥控/5200mAh/3kg 料仓） | 402¥ | **8/19 上架在售**（28 天榜单 ~380 件/600 万₽ 全铺货无品牌），1033.4¥/12990₽，破零价 11990₽，库存 10，净利 24.5%（官方计算器实测物流 2161₽，底价 10306₽）。仓：CLE陆运5 Premium Small |
| MAR-ICE-BLADE-150-01 | 6081041232 / 5573175131 | 冰钻替换刀片 150mm 一对（不锈钢弧形） | 29¥ | **8/23 上架在售**（刀片 130 同骨架变体扩展，MORA 4741₽ 高价锚/KEMAIWEI 同源），198.1¥/2490₽，库存 50，净利 53%。货源：杭州泰兰科（KEMAIWEI 源头厂）150mm 档 |

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

**每日学习多平台升级（2026-09-06，commit `6bcc85f`）**：源 1 B 站关键词 4→14（运营/选品/广告/内容评级/俄电商/Yandex/船外机维修/冰钓冬钓/跨境物流/选品方法）；源 2 新增 **vc.ru 俄文一手电商源**（标签 RSS `vc.ru/rss/tag/{ozon|маркетплейсы|wildberries|e-commerce}`，72h 窗口每标签 2 篇，content:encoded 全文提炼）。多源抽象 `LearningItem`（sourceId 幂等）；飞书简报**无论有无新入库都发**（force:true 突破静默，模板含分源扫描/门禁拦截/去重统计——此前 learned:0 静默导致"没启动"误判）。scheduler 首跑双跑修复（tick 等 stagger 时点，fake-timers 回归测试）。候选待扩：seller-edu.ozon.ru（SPA 需适配）、Habr（RSS 迁移中）、YouTube（需代理）。

### 推广汇报链路（2026-08-13 修复，commit `8acbe4c`+`2dce21f`）

**问题**：飞书群日报/周报/决策卡片全是硬编码假数据（实证 7/31-8/12 全部消息）：日报永远 0 单（daily_sales 表无 job 写入）、周报 `orders:0` 写死、"广告花费"实为 LLM token 成本、自然流 70/30 拍脑袋、决策卡片空壳（商品源 `/api/inventory` 查空表 product_performance 且 cost 硬编码 0）。

**修复**：
- 日报/周报订单+销售额：改查 `ozon_orders`（`date(created_at_ozon)`，含取消单统计）——8/10 首单已补录（cancelled 态）。
- 广告花费/ROI：新增 `services/ozon-ads.ts`（Performance API，`OZON_PERF_CLIENT_ID/SECRET` 已入服务器 env，实测 8/1-8/12 花费 781.61₽）；付费/自然流按广告订单真实拆分；API 不可用返回 null（日报显示"未接入"，不造假）。
- 决策引擎商品源：`/api/inventory` 空表时 fallback Ozon API 实时拉在售（list→info→**v5 prices**→**v4 stocks**，90s 缓存）+ 成本取 `sku_1688_mapping.purchase_price_cny`（MAX 保守）；空评分不再发空卡片；自动执行保留（20% 幅度+10 次/日限额）。
- **Ozon 端点下线实测（重要）**：`/v4/product/info/prices` 已 404 → **必须用 v5**；`/v2/products/stocks` 是"设置库存"不是查询；**查询库存用 `/v4/product/info/stocks`**（v3 同名已 404；jobs 一致性检查同步修复）。
- 测试 +18，全量 403 绿。

### 广告与促销
- **CPS（按订单付费 22%）已于 8/18 开通**：店铺级启用，当前覆盖 8 个达标在售 SKU（COVER-M/S 38.9%/38.8%、6E7 31.7%、GEN-CARB 28.3%、DOOR 27.4%、6E5 27.1%、61N 19.7%、66T 16.9%——全部 ≥15% 净利达标）；磁吸/摩托支架因开 CPS 即亏（-9%/-4.6%）已归档排除。
- **CPC**：61N 已于 8/18 首开并激活：campaign id 36145753「61N CPC」（用户手动创建），2000₽/周（Ozon 硬性最低，1件商品），搜索与推荐位，周二–周一周期；策略=自动 MAX_CLICKS（用户 8/18 明确拍板保持，仅此例外；监控若平均 CPC 持续 >15₹ 再报用户处置）。监测：temp/cpc-monitor-36145753.cjs + 每日 09:43 cron（01M09PVMZA7GFTV1KQJ78KHV0M）；67F-02 已在售（8/18 换品重建），重开 CPC 仍按平均 CPC ≤15₹ 口径，先报用户确认。
- **CPC 两次实证止损**（学费 842₹）：磁吸 33706085（CPC 57₹）+ 67F 33938265（CPC 43₹，728₹/0 单）。**铁律：自动策略 MAX_CLICKS 对窄品类长尾件出价失控，冷门件零评价期不投 CPC；正确形态=平均 CPC 策略 ≤15₹（保本线内）**（8/18 例外：61N 首开用自动策略系用户明确拍板，监控兜底）。重开条件：67F 审核恢复 + 任一 SKU 出单有评价。
- **破零促销在跑（均"我正在参与"）**：磁吸 4127830（至 8/14）、67F破零（至 8/16）、61N 4154063 + 6E7 4154141（8/6-8/19）。
- **CPS**：新品期不可用（需 14 天 1 单）。**评价积分 8/4 已停发**——邀评靠平台原生推送。
- **WOW 大促（9.25-10.15）**：9/3 报名检查提醒（cron a9931c5e），7 SKU 全符合 60 天新品免门槛。
- **8/24 合同新规（8/15 系统通知）**：转交货物时商品卡片未指明所贴条形码（EAN/OZN）→ Ozon 有权拒付赔偿；卡片内容违规可罚款。**9 在售品 OZN 条形码 8/19 已全部生成补齐**（码=OZN+sku）；⚠️ 发货实物必须贴对应 OZN 码（线下操作）。7/10 通知：吉尔吉斯斯坦新增 CEL 全档位配送+取货点——多站点分发评估加速项。
- **Yandex 站外**：未充值，暂停。

### 选品公式（实盘验证版，后续扩品统一按此）
**四重验证全过才上架**：①趋势/需求数据（官方 28 天搜索查询+销售榜）②竞争验证（Ozon 实时搜索页：避开本土 FBO 品牌墙/评论池垄断）③1688 货源（成本/起批量/跨境专供/素材干净度）④单元经济（毛利≥40%，售价≥800₹ 物流铁律，≤500g/≤60cm，CEL Extra Small 价≤135¥ 超出走 Small 仓）。
**放宽（8/5 定稿）**：不强制型号门槛——可与 rFBS 跨境同行竞争（打机翻/搬运图）；优先"已动销+中国供应链+利润可观+未来刚需"。**买点证据链两问必答**（凭什么转化/需求定位一致吗——狗靴 S5 教训）。
**8/19 秋冬赛道扩框（用户定调）**：不局限船配——**俄罗斯本土无产能、打当地铺货卖家、差异化**三原则；季节互补：船配（春夏）+ 冰钓（秋冬）。实证首发：冰钻刀片（28 天榜早鸟 9 件类目空白，净利 54%）+ 打窝船（28 天榜 380 件/600 万₽ 全无品牌铺货，净利 36%）；储备：船用登船梯（2+1 步 ¥125→3126₽ 净利 20%）。数据源：后台"分析→Ozon 上的商品"销售榜 28 天（类目筛选+动态排序），搜索查询页 28 天周期为 Premium 限制（7 天可用）。
**永久黑名单**：通用卡扣/LED 灯泡/普通雨刮/机滤/汽车通用火花塞/平衡杆胶套/三滤/刹车/转向/气囊/喷油嘴/氧传感器/高压传感器/220V 带电/液体/粉末/易碎/大件。
**标题红线**：**禁含他人品牌词**（Yamaha/Haval 等——67F 侵权停售实证；副厂件用"аналог+OE 件号"表述，OE 件号不是商标可用）；hashtags 同禁；**信息图/富内容配图同样禁品牌词与原厂型号段**（67F 二次实证：文本清干净了但 3 张信息图带 YAMAHA/F75-F100 仍被下架，8/18 归档重建；F75 等型号段统一改马力段 75-100 л.с. 表述）。

### 自动调价方案（2026-08-14 用户定稿，决策引擎自动执行）
- **触发**（每 4h 决策周期，基于精准竞品快照）：①价格高于竞品均价 5%（不利可降）②低于竞品均价 15%+ 且利润充足（适度涨价）③毛利率 <20%（提价修复）
- **双底线（不破底价绝不调）**：底价 = max（毛利率 20% 线 `成本₽/0.80`，净利率 10% 线 `(成本₽+物流₽)/0.70`）——净利口径含佣金 20%+CEL 物流分档（**8/20 起用官方计算器实测费率**：XS(≤135¥且≤500g) 95₽、Small(135-635¥且≤2kg) 300₽、Premium Small(635¥+且≤5kg) 2161₽；打窝船实测后底价从估值 8219₽ 修正为 10306₽，现售 12990₽ 净利 24.5% 仍达标）。**不亏本卖**是铁律
- **建议价**：降=min（现价， 竞品均价×0.97)；涨=min（现价×1.05, 竞品均价）；利润修复=成本₽/0.75（毛利率 25% 水位）
- **保护**：单次幅度 ≤10%、每商品每日 1 次、全局每日 10 次、交叉验证（系统健康/预算）不通过不执行、执行结果卡片报告
- **8/18 幻影执行修复（bc86485）**：PUT `/api/inventory/:offerId/price` 原只写空的 product_performance 表（0 行更新）从不推 Ozon → 引擎每轮从实时 fallback 读同一旧价、重复同一调价永不收敛（日志"Auto price updated"全是假成功）。已修：先推 `/v1/product/import/prices`（RUB→CNY 按汇率换算），Ozon 确认 updated 后才落库+审计；失败返回 502 不装成功。测试 11/11 覆盖推送载荷/失败路径
- **8/19 跨档迁仓（71cfcf4 已自动化）**：调价跌穿 135¥ 的商品库存同步从 CEL陆运3(Small) 迁回 CEL陆运(Extra Small)——价格带跨档=价格+仓库两件事，否则报"所选配送方式不适用此价格"。调价路由推送成功后自动幂等迁仓（目标仓=rfbs 总库存、另一仓=0，失败不阻断），手动兜底 `temp/move-stocks-xs.cjs`
- **官方指数校准**（待做）：每日抓一次官方价格指数（价格页 WebBridge）与自算口径对比，偏差大时告警

### 竞品监控双链路（2026-08-14 上线）
- **官方价格指数（Ozon 后台）**：7 个 SKU 共 31 条精准竞品链接已提交审核（COVER-S/M 各3、6E7 7、DOOR 8、GEN-CARB 6、61N 4；67F 下架恢复后补、磁吸/摩托支架无留档）。入口：价格页"未指定→添加"（无竞品时）或 `/app/prices/manager/{product_id}/prices` 价格管理页"Ozon上的竞争对手价格→添加链接"。添加后 72h 内指数重算——目标把 50%"不利"扭转为"有利"（搜索提升+"就是这个价"徽章）。**实证：GEN-CARB 的不利来自 Ozon 自动匹配的 wildberries 同款 1700₽（指数 1.36）**。8/18 补：67F-02（6017235420）3 条精准链接已提交审核 + promo_competitor_links 已迁移。
- **自抓精准快照（我方系统）**：`promo_competitor_links`（34 条留档）→ 本机 `temp/competitor-scan.py`（WebBridge 开竞品页提取价格/评分/评论数）→ `POST /api/promo/competitor-snapshots` 入库（`promo_competitor_prices.competitor_url` 区分精准/聚合）。competitor-watch 精准快照优先（12h 新鲜度）、decision-engine 均价精准优先。首轮 34/34 全部成功（实证与调研期价格/评论数吻合，数据可信）。**调度建议每日 2 次**（快照 12h 新鲜度门槛）。
- 历史结论：服务器到 Ozon 前台被风控拒连（api-seller 通），竞品页只能本机 WebBridge 抓（同 1688 素材两段式）；原"按名搜索竞品"实际在**自己店铺商品里模糊匹配**（ensureCategoryCache 拉自家 /v3/product/list）——数据从来都是假的，已被精准模式取代。

### 关键工具（全部固化可用）
- 采集：`temp/auto-scan.cjs`（Ozon 搜索页批量筛查，13 词 2.5 分钟）、`temp/src1688-scan.py`（1688 搜索+商品页，GBK 编码）、`scripts/download-1688-assets.cjs`、`scripts/filter-images.py`、`temp/wb.py`（WebBridge 通用 POST 助手，请求文件方式防转义）
- 制作：`temp/make-carousel-videos.py`（轮播视频生成，含 67F/6E7/door/boat-cover/carb-kit/gen-carb 六套 config）、`temp/listing-*/build_images.py`（各品信息图脚本）
- 上架：`temp/ozon-api.cjs`、`temp/ozon-list-*.cjs`（建品模板）、`temp/upload-frames.mjs`、`scripts/validate-rich-json.cjs`
- 广告：`temp/perf-api.cjs`、`temp/cpc-monitor-33938265.cjs` / `temp/cpc-monitor-36145753.cjs`（campaign 监测，只读）
- **WebBridge 要点**：daemon 卡死用 `kimi-webbridge.exe stop→start`（PID 残留删 ~/.kimi-webbridge/daemon.pid）；链接 slug 尾号用 **sku 不用 product_id**（O11）；session 失效换新 session 名；后台操作 CDP 真实点击+JS 写文件再 evaluate。

### 活跃 cron 任务
| id | 时间 | 内容 |
|---|---|---|
| a9931c5e | 9/3 10:47 | WOW 大促报名检查（7 SKU 免门槛） |
| 01M09PVMZA7GFTV1KQJ78KHV0M | 每日 09:43 | 61N CPC（36145753）+ CPS 数据监测：跑 temp/cpc-monitor-36145753.cjs，平均 CPC>15₹ 或周花费近 2000₹ 报警（不改策略） |

### 批量改品事故与回滚实证（2026-09-04/05，用户定性"重大失误"）

**事故**：批量"优化"在售品（换主图+补属性）时 ①sku↔货源↔图片**对应关系搞乱**（ice-blade 主图变成化油器零件图、6e5 主图变部分零件图）②属性填**估算通用值**（6e5 重量 150→错填 300/360、67f-02 52→错填 200/240）③import attributes 全量替换把用户真实特征（85 品牌/10096 颜色/10400 质保/4389 产地/22661 类型/5309 材质/23171 标签）全部冲掉 → 多品内容评级跌破 30，Ozon 判 ice-blade"变成另一个商品"。

**铁律（每一条都有本次实证）**：
1. **批量动生产数据前必先 dump 快照**：`/v4/product/info/attributes` + description + images 全量落盘 `temp/qa-<sku>.json`。本次回滚能成功，全靠 `temp/qa-67F-infringe.json`（修改前快照）和 `temp/ozon-list-*.cjs`（上架原版脚本，含全部真实属性/图 URL/价格/尺寸）。
2. **估算值/通用值绝不写商品真实属性**。属性只能来自：货源实测、建品原版记录、修改前快照。4383/4497/7956/8416 与顶层 weight/depth/width 保持同一真实数据的单位换算（g、cm=mm/10）。
3. **import attributes 是全量替换**：重提必须带上 `11254` 富内容和**全部**要保留的特征，缺什么丢什么。
4. **import task `imported` ≠ 已生效**：必须 `/v1/product/import/info` 逐 item 查 `errors`——回滚首跑 status=imported 但带 missing_dimension，数据根本没应用（假成功）。
5. **dimension 必须顶层平铺 + 单位字段**：`depth/width/height`(mm,int) + `weight`(g,int) + `dimension_unit:"mm"` + `weight_unit:"g"`，缺即 missing_dimension 拦全单。
6. **BR_hashtag_brand**：23171 标签禁品牌词（回滚携 `#yamaha` 被整单拦下；67F 快照原版无品牌词标签才安全）。
7. **DESCRIPTION_DECLINE（图与名不符）**：建品必须**显式填具体 name**——不填 Ozon 用 8229 类型值（如"Аксессуары для судов"）当名称，审核判主图与名称不符；**信息表/尺码表不能占 images[0]**，主图位必须是产品图（cover-s 实证：尺码表排第一被判"主图未展示商品"）。
8. **pictures/import 响应即写入确认**（`is_primary:true`+`state:imported`）；attributes 接口 images 字段有缓存延迟，**勿当失败重试**（同 payload 重提会 `skipped`）。
9. **先单验证再批量**：1 个品全流程（提交→task 零错误→attributes 复查→目检图）通过后才推其余；批量映射逐条核对 sku↔货源↔图，不凭数组顺序推断。
10. **子代理/新会话开工前必读本节与知识库**（用户直指：压缩后已有成熟方案没被引用导致重踩坑）。派子代理 prompt 必须写明 SOP 路径与相关条目。

**回滚实证（全部 task 零错误 + attributes 复查通过）**：6e5 用 `temp/ozon-list-6e5.cjs` 原版重提（task 5571383517，8 图+8 特征+真实 150g/150×120×40mm+11254 富内容，主图恢复全家福）；67f-02 用快照重构（task 5571384478，9048=AMIC-67F-44352-02 防与停售 67F-01 合并、4191/desc 清洗 F 型号、23171 无品牌词，52g 恢复）；cover-s/m 用 `temp/import-boat-cover.json`+`temp/copy-boat-cover.json` 修复（task 5571406485：真主图 13320695927 置顶、S/M 具体名称、22661/10096/4389 补回、尺寸重量补全）。重提脚本落盘：`temp/reimport-6e5-67f02.cjs`、`temp/reimport-covers.cjs`（payload 同目录 .json 可复用）。

**货源映射"错行"真相（2026-09-06 五重验证翻案）**：`sku_1688_mapping` **全部正确，一条未错**——61N→837185927166（新通化油器包，用户实测+8/13素材+¥32吻合）、66T→608822032027（亚玛瑞，payload实证）、blade130→950785053114（江银刀片，选品包实证）、F20→993176717131（马力机械化油器包，9/1素材目检）、blade150→982609015553（泰兰科刀片130/150多规格，WebBridge实时标题实证）。**真根因=9/5 批量抓取（img-iteration）WebBridge 后台 tab 串页**：navigate 与提取竞态（后台 tab 节流未渲染完即提取），每个 manifest 记的是队列里其他任务的页面（61N 记成刀片、blade 记成 6E5 化油器包、F20 记成 67F 叶轮、blade150 记成 66T 化油器包），错素材直接进批量换图。**防范硬闸门**：①WebBridge 批量抓取 navigate 后必须校验"当前页身份==目标"（URL/页面 offer id/标题关键词）再提取，不符则 bringToFront 重渲染重试，连续不符标记跳过——未校验的 manifest 一律不可信；②素材入库前目检首图与品类一致；③故障期产物（temp/img-iteration/ 9/5 批次 manifest+images）标注不可信，以各品 8 月上架素材（temp/src-assets/、listing-*/）为准；④引用 1688 链接前实时取标题校验品类（链接内容可变，但本次非换品）。

**MCP 工具链接入（2026-09-06，双子代理调研后接入）**：`~/.kimi-code/mcp.json` 三个 server——①**excel**（excel-mcp v1.29.1，`~/.local/bin/excel-mcp-server.exe` 直连；⚠️ uvx 启动慢会超时，必须 exe 直连；PyPI 用清华镜像 `UV_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple uv tool install`）②**ozon-buyer**（eduard256/ozon-mcp-server 60★，`D:/Onzo/tools/ozon-mcp-server/src/index.js`，headless Chromium 过 Ozon 反爬：搜索/商品详情/买家评论三工具结构化 JSON——选品调研/竞品监控新通道，首请求过反爬 ~12s 后 0.3-1s）③**deepl**（官方 npx deepl-mcp-server，key 已配，俄语翻译+术语表）。**明确不接**：Ozon Seller 写操作第三方 MCP（个位数 star，生产风险大于收益；自研 wrapper 已全覆盖）；nexscope（付费 API，先小额实测）。skill 候选：motiful/product-shots（主图，MIT，待改造为 Ozon 规范+俄语版）。评估全录：`design-mcp-skill-survey-2026-09`（知识库）。

### 在售品优化实战（2026-09-06，按新 SOP 执行）

**背景**：用户归档至 6 个船配品（61N 已出单不动）。优化对象 5 个：6E7/66T/6E5/67F-02/F20-CARB。

**新 SOP 主图方案（调研后定稿，本次全面落地）**：1200×1600（3:4）白底产品大图——通用脚本 `temp/build-main-sop.mjs <输入图> <输出.jpg>`（白底筛选→近白提纯（mn>240 且 mx-mn<12，**勿放宽**：228 会吃掉白色塑料件，F20 浮球实证）→bbox 提取→面积 0.68/单边≤0.95 缩放→白底合成）。**全家福类素材 bbox 面积口径必 FAIL（45% 左右属正常，单边顶格即可）**，单件产品 PASS 线 55-92%。供应商 logo 处理：顶部横带涂白预处理（66T 的 YAMARINE 顶标 y0-158 整行涂白）；中文水印横带用 `whiten_band`（6E5 成熟方案）；紫色中文水印用紫像素检测（`b>r+20 且 r>g+25 且 b>90`，含深紫 r≈80——`temp/listing-67F-v2/dewm_photos.py`，边缘残影可接受为副图）。

**各品动作**（全部 task 零错误+复查通过；payload 落盘 temp/reimport-*-payload.json）：
- **6E7**（task 5571656014）：名称/4180/图集全去 Yamaha（图 01/02/03 重生成）+23171 换衬套标签+补 4191(380字)/description（原空）/11254 富内容+补 85/10096/4389/4383 等特征。图集=新 SOP 主图+3 信息图+4 实拍。
- **F20**（task 5572548130）：名称去 Yamaha/Mikatsu→"Ремкомплект карбюратора 20-25 л.с. (4Т), аналог 65W/6BL..."；4191/23171（去 #f20 #f25）/description 清洗补全；图集=新 SOP 主图(img_02 全家福)+无品牌 01/02+03/04/05 细节图。
- **66T/6E5**（task 5572568217/5572568419 + 4191 轻量推 5572550447）：新 SOP 主图置顶（66T 用亚玛瑞 img_01 涂顶标、6E5 用 img_02 whiten_band）；6E5 补 4191、66T 4191 去"Yamaha"保留 40X/E40X OE 串。
- **67F-02**（task 5572557683）：图 3→8（新 SOP 主图+原 4 张+去水印实拍 3 张）。
- **85（Нет бренда）补推实证**：import 里 dict(85,126745801) 对 6E5/6E7/67F-02 静默丢失（task 零错误但属性没落），单用 `/v1/product/attributes/update` 补推后 6E5/6E7 生效；67F-02 因内容审核排队暂未落（等审核）——**字典属性提交后必须复查，零错误≠落库**。
- 价格不动原则：import 必带当前价（v5 prices 实查：6E7=144.12、F20=150.4/196、66T=120.44/129、67F-02=112.2/139、6E5=146.9/194.5 CNY）。

### 下一步待办（按优先级）
1. ~~67F 审核恢复~~ → **已通过换品重建恢复在售（MAR-YAM-67F-02 / 6017235420，8/18）**；CPC 重开待用户拍板（原口径：平均 CPC ≤15₹，先小预算验证）
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
