# ONZO 踩坑记录（Pitfall Log）

> 每次踩坑必记：**问题 → 根因 → 修复 → 预防规则**。子 Agent 任务启动前先查本表避免重蹈。
> 维护：主 Agent 实时更新；上下文压缩前确保最新坑已入库。

## 选品与素材
| # | 坑 | 根因 | 预防规则 |
|---|---|---|---|
| S1 | 供应商"黑白款混卖"，图集颜色不一致误导买家 | 1688 多 SKU 商品页图含全部变体 | 选品时确认单一变体素材充足；图集颜色必须与颜色属性一致 |
| S2 | 评价区/买家秀图 124–220px 误作主图被拒 | 未查尺寸就用（img_13/14 这类小图） | **`scripts/filter-images.py` 先审计**：HD≥800 主图、400–799 副图、<400 弃；**HD 干净图 <3 张直接放弃该商品** |
| S3 | 中文营销图裁剪救场，反复残留中文 | 1688 小电器类目供应商图以中文营销图为主（常态非例外） | **禁止裁剪中文图**；素材不够走"卖点提炼俄文重制"（PIL 信息图模板） |
| S4 | 详情页尾部混入不相关商品图（吸尘器/清洁剂） | 1688 页面"推荐商品"被一并抓入 | 选图时核对与在售商品一致性，不相关弃 |
| S5 | 大码狗靴上架后归档：雨鞋≠冬季保暖（定位错位）+无宠物试穿图（无说服力卖点） | 纸面数据 GO 但没抠"品类真实使用场景与买点证据"——防水雨鞋答不了冬季保暖需求，静物摆拍无试穿图支撑不了转化 | 选品 GO 前加两问：**①这个品的买点证据链是什么（试穿/装机/实测图能搞到吗）②它解决的需求和定位一致吗**（别把雨季品当冬季品卖）；无试穿/场景实证的品类直接 NO-GO |

## Ozon 上架（API）
| # | 坑 | 根因 | 预防规则 |
|---|---|---|---|
| O1 | 价格传 RUB 被拒（currency_differs_from_contract） | 店铺合同币种 CNY | 价格一律 CNY 提交，currency_code:"CNY" |
| O2 | weight 0.18 报 int32 错 | weight 是 int32（克），非 kg | weight 填整数克；depth/width/height mm |
| O3 | 尺寸/重量与类目校准不符（ОВХ 严重错误，PRODUCT_IS_NOT_CREATED） | 类目按大类均值校准（如电热水壶按 1-2L） | 类目按商品真实形态选（300ml 车载杯→保温杯类目，非电热水壶类目）；**严禁虚标尺寸** |
| O4 | 库存 PRODUCT_IS_NOT_CREATED | 商品审核未过即设库存 | 创建后等 3–5 分钟+重试（≤4 次）再设库存 |
| O5 | 库存 errors:[] 被误判为失败，重复设置致 4 仓各 20 | 打印逻辑 bug | `errors:[]` 即成功；设库存前先读现有值 |
| O5b | pictures/import 误用致"只剩主图" | 误以为"追加"：批量补 8 张后又单独 import 主图复位——**每次调用都是"以本次 URL 列表全量设置"**，单独 import 主图=把其余 7 张顶掉；且**数组第一张成主图**（非"最新一张"） | 图片**一次性按最终顺序导入**（主图放数组首位），不再二次单独补；拉图异步（分钟~小时），用 /v3/product/info/list 的 images 数判进度（pictures/info 接口对新品不准） |
| O6 | /v3/product/info/list 查单商品 400/空 | 该接口对单商品查询不友好 | 状态用 /v1/product/import/info{task_id} 或后台 |
| O7 | 标题同义重复被拦（термокружка/чайник/кипятильник） | 标题堆砌同义词 | 标题去重：核心词 1 次+特性词，不超过 ~100 字符 |
| O8 | 改类目被拒（description_category_has_no_description_type） | 跨大类目直接改不支持 | 新 offer_id 在正确类目重建，旧商品归档 |
| O9 | v3/product/import 的 item.description 静默丢弃（task 无报错，Ozon 侧描述长度 0） | 部分类目描述不走 item.description 字段 | **描述必须走 attribute 4191（Аннотация）通道**（/v1/product/attributes/update）；建品后必查 /v1/product/info/description 长度 |
| O10 | 4191 描述被拒（FB_ORIGINAL："卡片含正品销售表述"） | 副厂件文案用"оригинал*"字眼（即使"比原厂便宜"这类对比句也拦） | 副厂件文案**禁用 оригинал***，改用 штатный（штатная деталь）/аналог；标题用 аналог 不受影响（已实证） |
| O11 | 前台检查商品跳"товар закончился"误判为不可售/审核中 | 商品链接 slug 尾号用 product_id 构造（x-{product_id} 是假 slug，跳错误页） | **链接尾号用 sku**：/product/x-{sku}/；验证可见性优先搜索验证，直达链接用 sku 构造 |
| O12 | 建品后标题/描述全空（文案 JSON 嵌套 sku_xxx 键，脚本按扁平键读全 undefined） | 建品脚本读文案前未核对 JSON 实际结构 | 建品前**先打印文案源 JSON 的 keys 核对字段路径**；提交后必查 name/description 实际值（/v1/product/info/description 长度） |
| O13 | 双变体合并失败：9048 不同→double_without_merger（变体特征全同无法区分）；9048 相同→SPU_ALREADY_EXISTS（重复商品） | 该类目只有"颜色"一个变体维度，S/M 同色不同码无维度可区分 | **无尺码维度的类目接受双独立卡**（9048 保持不同值）；合并前先看该类目 aspect=true 的属性有几个 |

## 图片与媒体
| # | 坑 | 根因 | 预防规则 |
|---|---|---|---|
| M1 | alicdn 图片 Ozon 拉取失败（webp 伪装/防盗链） | 1688 CDN 对非浏览器 UA 限制 | 图片一律本地转 JPG → 传服务器（/api/image/upload）→ 用服务器 URL |
| M2 | 上传图片 /images/{uuid}.jpg 返回 HTML（SPA） | Caddy HTTPS 缺 /images 路由 | Caddy 必配 /images/* 与 /tmp-images/* → api-services |
| M3 | 富内容 JSON 三次被拒 | ①blockName/0.4 ②img 缺 srcMobile/宽高 ③multimedia- 相对路径 | 按官方 schema（assets/ozon-rich-schema.json，V03 widgetName/0.3）；img 全尺寸五字段；src 用完整可下载 URL（ir-*.ozonstatic.cn/s3/multimedia-*）；**提交前 `scripts/validate-rich-json.cjs` 本地预检** |
| M4 | 后台删图/改图不生效 | 媒体 tab 操作后未点"保存商品" | 后台任何编辑后必须点"保存/保存商品"并确认 |
| M5 | API 无图片删除端点 | pictures/import 只追加，v3 import 合并 | 删图只能卖家后台手动（媒体 tab） |
| M5b | 图片管线重建期 v4 images 返回瞬时值（0/部分），据此反复补传会触发更多重建越搞越乱 | 把重建中的瞬时 0 当成真实缺失反复 pictures/import | 补图后**等 ≥10 分钟管线稳定再判真实图数**；瞬时 0 ≠ 缺失；只一次性全量传，不单独反复补。**新品期 info/list.images 返回值 7→0→1 乱跳（66T 实证），根本不可用于判图数——以卖家后台媒体 tab/前台为准** |
| M6 | 卖点信息图同模板同底图雷同，Ozon 去重+无竞争力 | 4 张信息图用同一模板+同一产品底图，视觉雷同被判重 | **信息图差异化**：同模板信息图 ≤2 张，其余用不同底图/真实场景/细节特写/使用图；模板只统一版式，底图必须多样 |

## WebBridge 自动化
| # | 坑 | 根因 | 预防规则 |
|---|---|---|---|
| W1 | 后台 tab 不渲染（骨架/白屏） | Chrome 对非前台 tab 节流 | navigate 后 CDP `Page.bringToFront`；就绪判断看表单字段非标题 |
| W2 | 铅笔/编辑按钮 target=_blank 开 session 外新 tab | WebBridge 只能管 session 内 tab | 用 SPA 内 `location.assign()` 同 tab 跳转 |
| W3 | evaluate 报 SyntaxError | bash→node→JSON→JS 四层转义吞反斜杠（\s→s） | 页面代码一律写文件（temp/*.js）再 evaluate，模板字符串内正则 `\\s` |
| W4 | 上传文件路径损坏（\t \v 被当转义） | 反斜杠路径在 JSON 中被解析 | 文件路径一律正斜杠（D:/...） |
| W5 | 上传后未保存丢内容 | 面板/页面关闭时未保存 | 上传后必点面板"保存"并验证槽位计数 |
| W6 | 1688 搜索乱码空结果 | 中文关键词需 GBK percent-encoding（非 UTF-8） | 搜索 URL 用 GBK 编码（python quote(s.encode('gbk'))） |
| W7 | daemon 重启电脑后未就绪 | 无开机自启 | Startup 文件夹 kimi-webbridge-start.bat（已配） |
| W8 | 前台提问/日历等交互无响应，fill 报 "Uncaught" | Ozon 前台 isTrusted 校验合成事件；textarea 不兼容 fill | 一律 CDP `Input.dispatchMouseEvent` 真实点击；文本输入用 focus + `Input.insertText` |
| W9 | navigate 返回 success 但页面没跳/截图与 URL 不符 | ①SPA 场景 navigate 静默失败 ②后台 tab 被 Chrome 节流不渲染 | **navigate 后立即 `Page.bringToFront`**（解节流）；仍不跳用 CDP `Page.navigate` 强跳；评价页面状态以 list_tabs + evaluate 为准，别信 navigate 返回 |
| W10 | 点击"不利›"等链接后找不到新页面元素 | Ozon 后台这类跳转是 target=_blank 开新 tab，**不在 WebBridge session 的 tab 组里** | `find_tab {url, active:true}` 借用用户当前 tab 接管；价格管理详情页 URL 规律：`/app/prices/manager/{product_id}/prices`（可 SPA 直达，竞品链接入口在"Ozon上的竞争对手价格"卡片） |

## 平台规则与运营
| # | 坑 | 根因 | 预防规则 |
|---|---|---|---|
| P1 | 引用过时广告工具（трафареты） | Ozon 2025-09 已合并为 Оплата за клик | 广告/规则类信息先查官方最新文档，不凭记忆 |
| P2 | "新卖家 5000 广告积分"不存在 | 2022-23 旧活动，现行 Ozon Селект 周积分 | 平台活动以官方公告为准；经验数据标"未证实" |
| P3 | 履约指标阈值引用错误 | 官方是 Индекс ошибок ≤2%，非取消率 4% | 指标口径以 seller-edu 官方库为准 |
| P4 | 评价积分工具时限 | 2026-08-04 取消 | 有时限工具标注截止日期，提前布局替代 |
| P5 | 商品合并违规风险 | "型号"合并仅限同款变体（尺寸/颜色/容量） | 磁吸/夹持等功能差异款分建商品卡，用"相似商品"关联；9048 型号名保持店铺内唯一 |
| P6 | 标题/富内容含禁词或外部链接 | Ozon 内容规范 | 文案去外链/联系方式/行动号召；营销图无价格折扣文字 |
| P7 | "realFBS 商品无法订购"通知虚惊一场 | 新商品特征（重量/尺寸/价格）同步完成前触发误判，次日系统复检自动消除 | 收到通知**先查"物流→仓库和方式→错误"选项卡当前状态**：空=已自愈别瞎改；有货再对照承运商限制修。CEL Extra Small 硬约束：价格 0.01–135¥、重量 1–500g、单边 ≤60cm——磁吸 99¥ 已占上限 73%，涨价/加重前必查类目踢出线 |
| P8 | 跨境店找不到「Купоны」卖家券入口 | 跨境后台促销工具与本土店不同：无 Купоны，促销码仅固定金额且不支持选品 | 百分比折扣走「我的促销活动→折扣」机制；促销开始日强制 T+1 起（当天不可选）；该机制无次数限制字段，控量只能靠时限 |

## 服务器与部署
| # | 坑 | 根因 | 预防规则 |
|---|---|---|---|
| D1 | /var/lib/docker 50G 撑爆→502/构建失败 | buildkit 缓存 45G（deploy-watch `prune -f` 清不动） | deploy-watch 用 `builder prune -af --keep-storage 10g`（已修） |
| D2 | system prune -af 误删运行中容器+镜像 | 崩溃窗口期 prune | prune 前确认关键容器在运行；禁 --volumes |
| D3 | Caddy 单文件 bind mount 失效 | git reset 后 inode 变更 | 部署后必 `docker restart onzo-caddy`（deploy-watch 内置） |
| D4 | 插件同步失败 | ①SQL `INSERT OR REPLACE` PG 不兼容 ②OPTIONS 预检被 auth 401 | SQL 用普通 INSERT（时间戳 id）；authMiddleware OPTIONS 短路 204 |
| D5 | Ozon webhook 全部静默吞掉（零落库零告警） | 接收器假设推送带 X-Ozon-Signature 并据此 401/静默，**实测 Ozon 推送不带签名头**；且报文字段是 message_type/order_number/uuid 而非假设的 event_type/posting_number/event_id | **外部推送格式以实测为准**，别信臆测；无签名防护用 seller_id 白名单+IP 白名单；接收器对"无法处理但已收到"的请求必须打 warn，禁止静默 200 |
| D6 | 定时任务全瘫但服务"健康" | scheduler leader 锁续约依赖 `cache.getClient()`，而该方法从未挂到 cache 单例上——续约永远失败，leader 每 30s 丢失与 60s job tick 谐振后恒落空 | 跨模块动态调用（`as any` 取方法）要在集成测试验证；**job 报错必须带内容**（只记数量的 errors:1 排查了两天） |
| D6b | deploy-watch 构建失败后**永远不再重试** | 检测条件是 `HEAD == origin/main 即跳过`，而构建失败时 git 已 reset 到最新——HEAD 追平后判定"已部署" | 部署后必须验证容器 StartedAt/新代码特征（别信 git 状态）；构建失败时手动 `docker compose --profile production --env-file .env.production up -d --build` 重跑；deploy-watch 待改为比较"构建成功标记"而非 git HEAD |
| D6c | Ozon 预警 webhook"不稳定/响应慢报错"（3 天停推威胁，9/1 实证） | **deploy-watch 部署窗口（api 重建秒级断线）撞上 Ozon 推送/探测的失败累积**——webhook 本体健康（响应 <30ms、事件全 done），预警是部署窗口连接拒绝的历史标记 | ①别被预警吓到：先查 ozon_webhook_log 确认事件都 done（别信 Ozon 状态字面）；②后台"设置→API 集成→通知→编辑地址"实时探测显示"URL 可用"即恢复，保存后状态走"验证中→可用"；③Ozon 推送自带重试（失败后重推成功，事件不丢）；④响应链已 <30ms 无需加速，真正要做的是缩短部署窗口（deploy-watch 已是秒级最小窗口） |
| D7 | Ozon 订单同步拉到单却写库失败（154 次 errors） | order_id 用 INTEGER，Ozon 订单号 11 位（38394336004）超 PG int4 上限 | **外部平台 ID 一律 BIGINT 或 TEXT**；新链路上线后用一条真实数据端到端验证写库 |

## 流程与协作
| # | 坑 | 根因 | 预防规则 |
|---|---|---|---|
| F1 | 同一错误反复犯（中文混入/小图/裁剪） | 凭记忆干活，无检查清单 | **每个 SKU 过质检关卡（子 Agent 验收）；素材先 filter-images 审计；选品先查干净度** |
| F2 | 凭记忆引用平台规则/工具/阈值 | 信息过时 | 规则/工具/阈值一律先查官方最新文档再引用；未证实标注 |
| F3 | 破坏性操作不可逆（删商品/归档） | Ozon 商品不可物理删除 | 商品操作优先归档（可恢复）；删除类操作先确认 |
| F4 | 上下文压缩丢工作状态 | 无交接文档 | 每阶段更新 `docs/current-pipeline.md` + 本表；压缩前确认最新状态入库 |

## Ozon 上架与图片更新坑（2026-09-05 实证）

1. **attribute 9048（型号名称/合并卡片）是必填**：为空时商品有严重错误，Ozon 拒绝应用任何更改（图片/价格/文案全部不生效，显示旧卡片）。命名规则：`AMIC-<机型>-<OEM件号>`（如 AMIC-61N-W0093）；同商品不同变体（停售重建版）用序号区分（AMIC-67F-44352-01 vs -02 防误合并）。
2. **9048 相同=强制合并成一张卡片**：不同商品型号名必须不同；同商品尺寸/颜色变体才应填相同值合并（变体集中提升转化）。
3. **import 更新图片必须带全套**：price + weight(克) + 顶层 depth/width/height(mm，**平铺非嵌套 dimension 对象**！) + attributes 尺寸重量(4383/4497/7956/8416)。缺 dimension 报 missing_dimension 阻止整个导入（图片也不生效）。
4. 图片传**公网 .jpg 直链**（Ozon 下载入库），URL 必须 Ozon 可访问；图片审核比属性慢（几分钟到几小时）。
5. 品牌属性 85 必须显式传（无品牌也要传"Нет бренда"+dictionary_value_id）；部分类目（如打窝船）"无品牌"触发 BR_wrong_name 认证错误，需品牌证书或改类目。
6. 货源映射要核对 1688 链接商品标题与品类一致（本次发现 3 个化油器链接错挂成叶轮/刀片/打窝船）。
