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
7. ~~Rich-контент JSON（attr 11254）两次被模板拒绝~~ → 已解决：同款 JSON 在商品"在售"稳定后提交即通过（3 个 img+text 块，相对路径 `multimedia-*/….jpg` 可用）。**规律：审核/导入处理中的商品富内容校验更严，等"在售"后再提交**。富内容不计入内容评级分（100 分不含它），作用是提升转化率。
8. 视频：API 无公开上传接口（21841/21845 属性只接受 Ozon 视频 id）→ 卖家后台手动传，本地视频在 `temp/listing-staging/`。
9. 前台索引有延迟（数小时~1 天）：后台"在售" ≠ 前台立即可见。

脚本（temp/，流程跑通后可固化）：`ozon-api.cjs`（API 客户端）、`ozon-list.cjs`（创建）、`ozon-enrich.cjs`（属性补全）、`listing-payload.json`（文案/定价/素材清单）。

10. 图片公网 URL 链路：`POST /api/image/upload`（X-API-Key 头）存 api 容器 `./data/images`，生成 `/images/{uuid}.jpg`——**必须有 Caddy HTTPS 路由**（`8e235ad` 修复，此前落 SPA 返 HTML，Ozon 拉图失败报"无法通过链接下载照片"）。⚠️ `IMAGE_STORAGE_PATH` 未挂卷，**api 容器重建后历史图片全丢**（新传不受影响）。
11. 商品图片三错误根因：主图 alicdn URL 实际返回 webp 内容 → Ozon 拒收（"无法接受这种格式"）+主图顶替+下载失败。**一律本地转 JPG → 传服务器 → 用服务器 URL**；`pictures/import` 最新成功的一张会自动成为主图。
12. 视频自动化链路（已固化）：`scripts/make-video-ru.py`（去中文音轨+烧俄文字幕，ffmpeg/libass）→ `scripts/upload-ozon-video.cjs`（WebBridge 操作卖家后台）。**两条上传路径**：默认媒体 tab 路径（列表 → SPA 内 `location.assign` 到 `/edit/general-info` → 媒体 tab →"添加视频"→注入→保存）；`--rating` 评级面板路径兜底（列表→评级按钮→面板内上传）。关键坑：①后台 tab Chrome 节流连骨架都不渲染，navigate 后必须 CDP `Page.bringToFront`；②骨架屏也有"商品编辑"标题，就绪判断要看"类目和类型"表单字段；③铅笔是 target=_blank 开 session 外新 tab，WebBridge 接管不到，须用 SPA 内跳转；④点击媒体 tab 可能不切 URL，需 `location.assign` 直达保底；⑤文件路径用正斜杠；⑥上传后必须点"保存"，关页未保存则丢失。媒体 tab 页还有"添加图片/视频封面/富内容"入口，同法可扩。

## 七、平台规则情报（2026-07-28 Ozon 公告）

- **商品合并规则（强制）**："型号"合并仅限同款的尺寸/颜色/容量变体；功能形态不同的商品（如磁吸款 vs 夹持款）不得并入同一型号组，应分建商品卡用"相似商品"关联。违规有 7 天修正期，系统性违规暂停全部商品组展示。9048 型号名保持店铺内唯一值（防误合并+防虚假分组，现做法已合规）。
- **评价积分取消（2026-08-04 起）**：不再显示评价积分徽章、停止发放评价积分。新品首批评价依赖 Ozon 推送邀评/主页通知等保留工具——出单后主动引导评价更重要。
  - 冷启动现状：2025-07 起新品**默认开启**评价积分（卖家出积分 1分=1₽ + Ozon 10% 佣金；10 条约 770₽）。取消前是末班车，后台"推广→评价积分"可查/调积分值（带图评价积分调高次日生效）。
  - 8/4 后替代路径：Ozon 保留的精选集提位、主页邀评通知、下单买家推送；售后话术合规邀评（禁止有偿好评）。

## 八、安全备忘

- 以下凭据曾在即时通讯中明文传输，建议择机轮换：Kimi K3 API Key、飞书 App Secret、Ozon API Key。
- 服务器 API_KEY 已在换服务器时轮换过一次（值存于服务器 handover 文件，未进仓库）。
