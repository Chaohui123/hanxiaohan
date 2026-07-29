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

## Ozon 上架（API）
| # | 坑 | 根因 | 预防规则 |
|---|---|---|---|
| O1 | 价格传 RUB 被拒（currency_differs_from_contract） | 店铺合同币种 CNY | 价格一律 CNY 提交，currency_code:"CNY" |
| O2 | weight 0.18 报 int32 错 | weight 是 int32（克），非 kg | weight 填整数克；depth/width/height mm |
| O3 | 尺寸/重量与类目校准不符（ОВХ 严重错误，PRODUCT_IS_NOT_CREATED） | 类目按大类均值校准（如电热水壶按 1-2L） | 类目按商品真实形态选（300ml 车载杯→保温杯类目，非电热水壶类目）；**严禁虚标尺寸** |
| O4 | 库存 PRODUCT_IS_NOT_CREATED | 商品审核未过即设库存 | 创建后等 3–5 分钟+重试（≤4 次）再设库存 |
| O5 | 库存 errors:[] 被误判为失败，重复设置致 4 仓各 20 | 打印逻辑 bug | `errors:[]` 即成功；设库存前先读现有值 |
| O6 | /v3/product/info/list 查单商品 400/空 | 该接口对单商品查询不友好 | 状态用 /v1/product/import/info{task_id} 或后台 |
| O7 | 标题同义重复被拦（термокружка/чайник/кипятильник） | 标题堆砌同义词 | 标题去重：核心词 1 次+特性词，不超过 ~100 字符 |
| O8 | 改类目被拒（description_category_has_no_description_type） | 跨大类目直接改不支持 | 新 offer_id 在正确类目重建，旧商品归档 |

## 图片与媒体
| # | 坑 | 根因 | 预防规则 |
|---|---|---|---|
| M1 | alicdn 图片 Ozon 拉取失败（webp 伪装/防盗链） | 1688 CDN 对非浏览器 UA 限制 | 图片一律本地转 JPG → 传服务器（/api/image/upload）→ 用服务器 URL |
| M2 | 上传图片 /images/{uuid}.jpg 返回 HTML（SPA） | Caddy HTTPS 缺 /images 路由 | Caddy 必配 /images/* 与 /tmp-images/* → api-services |
| M3 | 富内容 JSON 三次被拒 | ①blockName/0.4 ②img 缺 srcMobile/宽高 ③multimedia- 相对路径 | 按官方 schema（assets/ozon-rich-schema.json，V03 widgetName/0.3）；img 全尺寸五字段；src 用完整可下载 URL（ir-*.ozonstatic.cn/s3/multimedia-*）；**提交前 `scripts/validate-rich-json.cjs` 本地预检** |
| M4 | 后台删图/改图不生效 | 媒体 tab 操作后未点"保存商品" | 后台任何编辑后必须点"保存/保存商品"并确认 |
| M5 | API 无图片删除端点 | pictures/import 只追加，v3 import 合并 | 删图只能卖家后台手动（媒体 tab） |

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

## 平台规则与运营
| # | 坑 | 根因 | 预防规则 |
|---|---|---|---|
| P1 | 引用过时广告工具（трафареты） | Ozon 2025-09 已合并为 Оплата за клик | 广告/规则类信息先查官方最新文档，不凭记忆 |
| P2 | "新卖家 5000 广告积分"不存在 | 2022-23 旧活动，现行 Ozon Селект 周积分 | 平台活动以官方公告为准；经验数据标"未证实" |
| P3 | 履约指标阈值引用错误 | 官方是 Индекс ошибок ≤2%，非取消率 4% | 指标口径以 seller-edu 官方库为准 |
| P4 | 评价积分工具时限 | 2026-08-04 取消 | 有时限工具标注截止日期，提前布局替代 |
| P5 | 商品合并违规风险 | "型号"合并仅限同款变体（尺寸/颜色/容量） | 磁吸/夹持等功能差异款分建商品卡，用"相似商品"关联；9048 型号名保持店铺内唯一 |
| P6 | 标题/富内容含禁词或外部链接 | Ozon 内容规范 | 文案去外链/联系方式/行动号召；营销图无价格折扣文字 |

## 服务器与部署
| # | 坑 | 根因 | 预防规则 |
|---|---|---|---|
| D1 | /var/lib/docker 50G 撑爆→502/构建失败 | buildkit 缓存 45G（deploy-watch `prune -f` 清不动） | deploy-watch 用 `builder prune -af --keep-storage 10g`（已修） |
| D2 | system prune -af 误删运行中容器+镜像 | 崩溃窗口期 prune | prune 前确认关键容器在运行；禁 --volumes |
| D3 | Caddy 单文件 bind mount 失效 | git reset 后 inode 变更 | 部署后必 `docker restart onzo-caddy`（deploy-watch 内置） |
| D4 | 插件同步失败 | ①SQL `INSERT OR REPLACE` PG 不兼容 ②OPTIONS 预检被 auth 401 | SQL 用普通 INSERT（时间戳 id）；authMiddleware OPTIONS 短路 204 |

## 流程与协作
| # | 坑 | 根因 | 预防规则 |
|---|---|---|---|
| F1 | 同一错误反复犯（中文混入/小图/裁剪） | 凭记忆干活，无检查清单 | **每个 SKU 过质检关卡（子 Agent 验收）；素材先 filter-images 审计；选品先查干净度** |
| F2 | 凭记忆引用平台规则/工具/阈值 | 信息过时 | 规则/工具/阈值一律先查官方最新文档再引用；未证实标注 |
| F3 | 破坏性操作不可逆（删商品/归档） | Ozon 商品不可物理删除 | 商品操作优先归档（可恢复）；删除类操作先确认 |
| F4 | 上下文压缩丢工作状态 | 无交接文档 | 每阶段更新 `docs/current-pipeline.md` + 本表；压缩前确认最新状态入库 |
