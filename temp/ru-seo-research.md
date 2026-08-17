# 俄罗斯 SEO + 站外引流调研报告（ONZO）

> 调研时间：2026-08-17 ｜ 背景：Ozon 俄罗斯跨境电商，主营船外机配件（化油器修理包/叶轮/衬套/船罩）+ 汽配（Haval 拉线）+ 发电机化油器，全部 OE 件号驱动搜索。
> 所有关键数据均附出处链接；标注"未找到可靠出处"的条目请谨慎采信。

---

## A. 俄罗斯搜索引擎格局 2025–2026

### 1. 市场份额（StatCounter 口径）

- **全平台**：2025-01 Yandex 75.51%（[TAdviser](https://www.tadviser.ru/index.php/%D0%A1%D1%82%D0%B0%D1%82%D1%8C%D1%8F:%D0%98%D0%BD%D1%82%D0%B5%D1%80%D0%BD%D0%B5%D1%82-%D0%BF%D0%BE%D0%B8%D1%81%D0%BA_(%D0%BC%D0%B8%D1%80%D0%BE%D0%B2%D0%BE%D0%B9_%D1%80%D1%8B%D0%BD%D0%BE%D0%BA))）；2025-03 Yandex 74.1% / Google 24.6% / Bing 1.01% / DuckDuckGo 0.18% / Yahoo 0.08% / Mail.ru 0.03%（[vc.ru](https://vc.ru/marketing/1872855-poiskovye-sistemy-v-rossii-kto-dominiruet-v-2025-godu)）
- **桌面端** 2024 全年：Yandex 73.47%（+8.5pct）vs Google 24.61%；**移动端** 2024：Yandex 68.4%（+10.6pct）vs Google 30.75%（[ppc.world](https://ppc.world/news/yandeks-za-god-ukrepil-pozicii-na-poiskovom-rynke-dolya-google-snizilas-esche-silnee/)）。Google 在移动端残存份额更高
- 2026-04 StatCounter：Yandex 73.04%；Yandex 自家 2025 年报口径 69.3%（方法论差异，[vc.ru](https://vc.ru/seo/2927476-populjarnye-poiskoviki-v-rossii)）。2026 年桌面 78.9% / 移动 65.8%（[digitalapplied](https://www.digitalapplied.com/blog/search-engine-market-share-2026-global-data)）

### 2. 背景变化核实

- **Google**：2022-03 停止在俄广告销售后份额持续流失——2022 上半年全设备尚为 49.35%（当时高于 Yandex 48.11%，[searchengines.guru](https://searchengines.guru/ru/articles/2056167)），2025 年已跌至 ~24–25%。主因：广告业务撤出、俄产软件强制预装法
- **Yandex 拆分**：2024-02 签约、以 4750 亿卢布售予俄投资者财团，2024-07 完成交割；Yandex N.V. 更名 Nebius Group（[Nebius 官方](https://nebius.com/newsroom/ynv-announces-successful-completion-of-the-divestment-of-its-russia-based-businesses)、[Kommersant](https://www.kommersant.ru/quotes/nl0009805522)）。搜索业务留在俄主体，拆分后份额不降反升（桌面 2023 65%→2024 73.5%），**未见负面影响**
- **VK**：2022-12 已关停自有 Mail.ru 搜索，改用 Yandex 搜索技术（[Oborot.ru](https://oborot.ru/news/vk-svernula-no-ne-zakryla-poisk-mail-ru-i-zamenila-ego-na-poisk-yandeksa-pochemu-postupili-imenno-tak-i174269.html)），独立份额 ~0.03%，可忽略

### 3. 电商搜索行为：站内 vs 站外

- **Ashmanov & Partners《Поиск 2026》**：71% 俄罗斯消费者直接在 marketplace 搜索商品（主题网店仅约 1/3）；2022 年中该比例为 46%，四年内完成迁移。动因：有评论 44%、有折扣 43%（[AdIndex](https://adindex.ru/publication/analitics/search/2026/02/9/342290.phtml)、[Sostav](https://www.sostav.ru/publication/marketplejsy-ne-stali-universalnym-instrumentom-dlya-poiska-tovarov-81531.html)、[原始 PDF](https://www.cossa.ru/news/add/Ashmanov_Search2026_Marketplaces.pdf)）
- 2025-09 调查：23% 用户**只**在 marketplace 搜商品，marketplace 参与 50% 的购物搜索场景（[ppc.world](https://ppc.world/news/kazhdyy-tretiy-polzovatel-vybiraet-tovary-cherez-iipodskazki-golos-i-poisk-po-foto/)）
- **反向证据**：大额/慎重购买中 62% 仍先用搜索引擎；28% 主用 marketplace、21% 从 Yandex/Google 起步（[RB.RU](https://rb.ru/news/marketplejsy-teryayut-monopoliyu-na-sereznye-pokupki-62-polzovatelej-vybirayut-poiskoviki/)）。即"搜索引擎不再是购物入口"对高频标品成立，对研究型购买不成立
- 盘子：АКИТ 2025 俄电商 11.5 万亿卢布（+28%），占零售 18.8%（[Sostav](https://www.sostav.ru/publication/rynok-e-commerce-v-rossii-dostig-11-5-trln-rublej-81869.html)）；Data Insight 口径 13.4 万亿（[datainsight.ru](https://datainsight.ru/DI_eCommerce_2026)）
- OE 件号类搜索（如 66T-W0093）的入口占比：**未找到可靠出处的专门研究**

### 4. Ozon 商品页的站外收录

- **实测 [ozon.ru/robots.txt](https://www.ozon.ru/robots.txt)（2026-08-17 抓取）**：`/product/` 商品页对 Yandex 和 Googlebot **均开放索引**（仅 `/search/`、购物车等被 Disallow），且为 Yandex 配置 `/product/` 专属 Clean-param 规则——Ozon 主动维护商品页可索引性
- 俄 SEO 社区共识：Ozon/WB 卡片的外部 SEO 仍有效，可从 Yandex/Google 获免费流量，但卖家主战场是站内搜索排名（[vc.ru 2025-03](https://vc.ru/id1120022/1889431-vneshnee-seo-dlya-marketpleysov-wildberries-i-ozon)）

**对 ONZO 的含义**：流量基本盘 = Yandex（~73%）+ Ozon 站内搜索（71% 用户起点）；Google 移动端残量 ~30% 不值得单独投入；Ozon 商品页做 OE 件号关键词（标题/属性字段）可同时吃站内搜索和 Yandex 站外收录两份流量。

---

## B. 俄罗斯用户船机/汽配件搜索习惯

### 1. 关键词类型分布：件号+品牌是主路径，品类词做品类页

- 汽配电商平台 Docpart（服务数千家俄汽配店）总结：配件搜索**绝大多数按"件号（артикул)+制造商"进行**，标准路径是"查原厂 OE 号 → 找 2–3 个替代号 → 多店比价"（[docpart.ru](https://docpart.ru/articles/kak-iskat-avtozapchasti)）。qwep 同样指出按件号搜索是俄网购配件常用方式（[qwep.ru](https://qwep.ru/articles/novosti-avtomatizaczii/podbor-avtozapchastej-po-nomeru-detali-udobstvo-i-riski/)）
- SEO 行业把汽配语义分四类：**品类词、品牌词、车型词、OEM/件号技术词**，并强调"原厂交叉号是最强商业流量来源，应放 H1/标题开头"（[vc.ru 汽配 SEO 分析](https://vc.ru/seo/2916769-prodvizhenie-sajta-avtozapchastej)）
- 船机配件更苛刻：只按品牌选不对件，必须"型号+马力+年份，最好加序列号"（[redan.ru 船机选件指南](https://redan.ru/blog/poleznaya-informatsiya/kak-vybrat-zapchasti-dlya-lodochnogo-motora-po-modeli-podrobnyy-obzor-populyarnykh-brendov/)）——印证 ONZO 的 OE 驱动模型

### 2. Wordstat 数据：无公开可验证数值，规律可佐证

- **如实标注**：Yandex Wordstat 网页需 Yandex 登录，"ремкомплект карбюратора""крыльчатка yamaha""66T-W0093" 的具体月搜索量**未找到公开可验证出处**
- 可佐证的规律：件号/артикул 查询属**低频（НЧ）词**，但"货号库是低频商品词的基础，且低频词转化率最高"（[FirstRank 汽配 SEO](https://l0i0i0l.ru/prodvizhenie-sajta-avtozapchastej.html)、[vc.ru](https://vc.ru/seo/2916769-prodvizhenie-sajta-avtozapchastej)）。即：品类词量大竞争高，件号词量小但几乎 100% 购买意图

### 3. 长尾与拼写习惯

- OE 号**一律以拉丁字母为标准形式**写入标题：Ozon 在售汽配卡普遍"品类词+品牌+型号+OEM+多个交叉号"（[ozon.ru 实例 1](https://www.ozon.ru/product/napravlyayushchaya-fr-supporta-toyota-corolla-1zrfe-sat-st-47715-12a10-oem-4771448150-primenima-dlya-1721550272/)、[实例 2](https://www.ozon.ru/product/filtr-salonnyy-ugolnyy-art-87139-30040-1-sht-1664313648/)）
- "品类+品牌+机型/马力+OE号"组合长尾真实存在：Дром 在售标题即"Ремкомплект карбюратора Yamaha 40 66T-W0093-00"（[baza.drom.ru](https://baza.drom.ru/moto-zapchasti/remkomplekty-karbyuratora/)）
- 品牌词双语并存：头部卖家同一标题同时写拉丁与西里尔品牌名（"Toyota…Тойота"），证明 yamaha/ямаха 两类输入都有量；另有俚语词现象（[vc.ru](https://vc.ru/seo/2916769-prodvizhenie-sajta-avtozapchastej)）

### 4. 中国车在俄配件需求爆发

- 保有量：在俄中国乘用车 2024 年约 145 万辆 → 2025 年初预计 235 万 → 三年内 500 万（Автостат，经 [kolesa.ru](https://www.kolesa.ru/news/rost-sprosa-na-zapcasti-dlia-kitaiskix-avtomobilei-svezie-dannye-ot-internet-magazina-armtek)）；新车份额从 2021 年 8% 升至 2025 年超 50%（[renins](https://content.renins.ru/osago/zapchasti-na-kitajskie-avtomobili/)）
- 搜索/销量：ARMTEK 中国配件专区上线两个月处理 100 万+ 次选型请求，最热品牌 Haval、Chery、Geely（[kolesa.ru](https://www.kolesa.ru/news/rost-sprosa-na-zapcasti-dlia-kitaiskix-avtomobilei-svezie-dannye-ot-internet-magazina-armtek)）；Avito 2024H1：Haval 配件销量同比 +93%、Chery +78%（[ko.ru](https://ko.ru/news/prodazhi-zapchastey-k-avtomobilyam-exeed-haval-i-chery-vyrosli-zametnee-vsego-s-nachala-goda/)）

### 5. 对 Ozon 标题布局的启示

- 推荐组合：**俄文品类词前置 + 品牌（拉丁+西里尔） + 机型/马力 + OE 号（+主要交叉号）**，与 Ozon/Дром 头部卖家实际标题一致；件号类低频词转化率最高（[vc.ru](https://vc.ru/seo/2916769-prodvizhenie-sajta-avtozapchastej)）

---

## C. 站外免费/低成本引流渠道（2025–2026 可用性）

### 1. VK (VKontakte) — 优先级最高

- 规模：2025 年俄 MAU 91.8M，12 月破 94M（[ppc.world](https://ppc.world/articles/auditoriya-devyati-krupneyshih-socsetey-v-rossii-v-2024-godu-issledovaniya-i-cifry/)、[eLama](https://elama.ru/blog/socialnye-seti-v-rossii/)）；船钓垂类活跃（如狩猎钓鱼社群 23 万订阅）
- 门槛：官方 FAQ 确认外国手机号（含 +86）经移动 App 可免费注册（[vk.ru/faq22108](https://vk.ru/faq22108)）。VK Маркет 开店收款需俄护照/ИНН，中国主体开不了（[SellyGenie](https://sellygenie.com/ru/blog/vk-market-prodazhi)）。自有社群发自家商品不算广告、免 erid 标记
- 挂 Ozon：官方集成免费同步商品卡进 VK 橱窗并回跳 Ozon 结算（[seller.ozon.ru](https://seller.ozon.ru/media/boost/kak-rabotaet-integraciya-ozon-i-vkontakte/)）；2025.10 起 ≥100 粉账号可发挂 Ozon 商品卡的 шопсы 帖/клипы（[eLama](https://elama.ru/blog/shopsy-vk-chto-eto-i-kak-ispolzovat/)）
- 效果：零投放案例社群 46→13,695 订阅、帖均自然触达 5,573（[uniseller](https://uniseller.io/blog/prodvizhenie-vkontakte-dlya-sellerov-marketpleysov)）

### 2. Telegram

- 规模：俄第一大通讯应用，2026.1 MAU 约 9569 万（[Mediascope/Habr](https://habr.com/ru/news/1006878/)）；船机垂类以经销商自营频道为主
- 门槛：仅需手机号；+86 可注册但常收不到短信验证码，可用语音来电/接码平台
- 挂 Ozon：频道帖挂 Ozon 链接无屏蔽；Ozon 官方「Бонусы за пост」直接奖励卖家发 TG 帖（3200–60000 卢布/帖，[ppc.world](https://ppc.world/news/ozon-budet-nachislyat-prodavcam-bonusy-za-reklamu-tovarov-v-telegram-i-vkontakte/)）
- 免费玩法：互推（взаимопиар）、频道合集、TGStat 免费自助收录
- 风险：2025.9 起俄广告法新规将 TG 付费广告列为受限，第三方频道付费帖有 10–50 万卢布罚款风险；自有频道自然帖不在此列（[pravo.ru](https://pravo.ru/story/262745/)）

### 3. YouTube vs RuTube / VK Video

- YouTube 未被封但持续降速：桌面/电视端最重、移动端相对可用（[CNews](https://www.cnews.ru/news/top/2026-01-21_v_rossii_otmeneno_zamedlenie)）；横版播放量跌约 30%，Shorts 最深跌 43% 后于 2025.12 恢复至降速前（中位约 4000 播放），仍值得做（[ppc.world/WhoIsBlogger](https://ppc.world/news/youtube-v-rossii-poteryal-tret-prosmotrov-video-a-shorts-vernulis-k-dokrizisnomu-urovnyu-bolshoe-issledovanie/)）
- RuTube：2025 MAU 8060 万（[Habr](https://habr.com/ru/news/988954/)）；邮箱即可注册上传、无需俄手机号
- VK Video：2025.12 MAU 8150 万、日活超 4000 万（[Kommersant](https://www.kommersant.ru/doc/8364261)）；Клипы 日均 34 亿播放
- 挂链：VK шопсы 格式强制挂 Ozon 链接；RuTube 描述区可加链接，未见禁止 Ozon 外链的官方规定（未找到明确条款）
- 效果：已有汽配卖家在 VK Video/Дзен 跨发视频附 Ozon 链接引流（[drive2 实例](https://www.drive2.ru/l/709421670867156275/)）

### 4. 船机论坛 — 可做但重人工、禁硬广

- 活跃度：[motolodka.ru](https://forum.motolodka.ru/) 主版块累计 236.6 万帖、当日有新帖；[katera.ru](https://forum.katera.ru/) 在线约 927 人。lodka.ru 域名无法解析、无 2024–25 新帖，疑似关停（未找到官方公告）
- 门槛：注册仅需用户名+邮箱，无需俄手机号
- 规则：跳蚤市场限每账号 5 条售帖、**明文禁止外链广告**（[motolodka 规则](https://forum.motolodka.ru/barah_rules.php)）；katera 版规禁止包括签名档在内的一切商业广告，有发商店链接被封实例
- 效果：论坛软广（крауд-маркетинг）仍可用但见效慢、效果「不可预测」（[vc.ru](https://vc.ru/marketing/143823-prodvizhenie-na-forumah-tri-kruga-ada-radi-nepredskazuemoi-effektivnosti)）

### 5. Avito — 中国卖家基本进不去

- 入驻：官方明确注册仅限俄罗斯手机号（[support.avito.ru](https://support.avito.ru/articles/4206)）；商业账号须俄 ИНН+对公账户，2025 年起无 ИП/ООО/самозанятый 无法商业发帖（[Tochka](https://reklama.tochka.com/blog/prodaja-tovarov-iz-kitaya-na-avito)）
- 唯一跨境通道：2024.12 上线跨境项目，定向筛选中国合作伙伴（非开放申请），2025.6 达 35 万 SKU（[Oborot](https://oborot.ru/news/na-avito-poyavyatsya-kitajskie-prodavcy-a-v-perspektive-i-tureckie-i230979.html)）
- 导流 Ozon：条款禁止描述中放任何外链，有因发链接被封聊天 7 天实锤（[vc.ru](https://vc.ru/id5310177/2961933-avito-zablokiroval-dostup-k-chatam-za-ssylki-na-ob-yavleniya)）
- 类目：船外机配件供给活跃（"карбюратор ямаха 30"在售 826 条），但免费额度仅 1 条/账户，"免费引流"不成立

### 6. Yandex Zen (Дзен)

- 规模：已归 VK 所有，官方公布 2025 MAU 7300 万（[VK 官方](https://www.tbank.ru/invest/social/profile/VK_official/e4206fd6-7b82-4027-b5c2-41bbef716174/)）；长文章占用户时长 63%，90–95% 流量来自俄
- 门槛：开频道免费，手机号注册 VK ID 即可；+86 收码稳定性未找到可靠出处
- 外链：官方规则未明文禁商业外链，但算法会降低含外链帖推荐量，惯例把链接放正文中后部（[wowblogger](https://wowblogger.ru/blog/kak-zarabatyvat-v-dzene)）
- 效果：爆款文章可长尾引流数周并被搜索引擎收录（[pressaff](https://pressaff.com/articles/traffic-dzen/)）

### 渠道结论

| 渠道 | 门槛 | 可挂 Ozon 链 | 推荐度 |
|---|---|---|---|
| VK 社群+шопсы | +86 可注册 | ✅ 官方集成 | ★★★ |
| Telegram 自有频道 | +86 可注册（收码不稳定） | ✅ 官方还发奖励 | ★★★ |
| YouTube Shorts / VK Клипы / RuTube | 邮箱即可 | ✅（描述区/шопсы） | ★★☆ |
| Дзен 长文 | 免费 | ⚠️ 限流，放文中后部 | ★★☆ |
| 船机论坛 | 邮箱注册 | ❌ 禁外链 | ★☆☆（软广养号） |
| Avito | 需俄主体 | ❌ | ☆☆☆ |

---

## D. Ozon 站内 SEO：标题/描述/属性/hashtags 的影响

### 1. 官方依据

**排名因素官方清单**（[Ozon 官方卖家媒体](https://seller.ozon.ru/media/boost/kak-prodvigat-tovary-na-ozon-rukovodstvo-dlya-nachinayushih/)）：9 类因素——受欢迎度（浏览/加购/收藏）、文本相关性（查询词与卡片描述的颜色、品牌等吻合）、销量（转化率+总销量）、价格（历史价格+当前折扣）、评分与评价数、配送速度、个性化、提升系数（大促、价格指数、物流加速）、付费推广。官方不公布权重。

**2025 年 6 月排名机制大改**（官方在 COM.E ON 论坛宣布，[Oborot.ru](https://oborot.ru/articles/ozon-poisk-izmenenia-82-i247409.html)、[SEOnews](https://www.seonews.ru/events/ozon-obnovlyaet-podkhod-k-ranzhirovaniyu-tovarov/)）：取消"前 12 位固定给付费商品"，改为统一公式 `最终分 = 有机权重×有机分 + 推广权重×推广分`，纯有机商品也能进顶部。

**标题规则**（官方帮助中心 [seller-edu.ozon.ru](https://seller-edu.ozon.ru/work-with-goods/trebovaniya-k-kartochkam-tovarov/nazvanie-tovara)）：上限 200 字符、首字母大写、禁促销词（акция/скидка）、禁特殊符号；推荐结构"类型+品牌+型号+关键参数"。**2025 年未见"强制自动生成标题"新规**——模板标题多数类目可手动关闭，但轮胎/机油/轮毂等汽配子类**强制模板**（船机配件不在其列，可自定义）（[vc.ru 2026-08](https://vc.ru/marketplace/3057177-seo-prodvizhenie-na-ozon-kak-vyvesti-kartochku-v-top)）。

**Hashtags 时间线**：2025-03 上线商品 hashtags（每品最多 30 个，初期官方称计入排名，[T-Bank](https://secrets.tbank.ru/novosti/ozon-heshtegi/)）；**2025-08-18 起 hashtags 正式取代旧的"Ключевые слова"SEO 属性**（[Ozon 官方新闻](https://seller.ozon.ru/media/news/vmesto-klyuchevyh-slov-teper-budut-heshtegi/)）。

### 2. 卖家实测（非官方）

- **描述是否被索引——两派打架**：[vc.ru 长文（2026-08）](https://vc.ru/marketplace/3057177-seo-prodvizhenie-na-ozon-kak-vyvesti-kartochku-v-top)称"描述完全不参与搜索，只算标题+属性"；[ESEO（2026-06）](https://eseo.su/blog/seo-ozon-poleznye-klyuchevye-slova)反向引用官方称"描述、属性、аннотация 均索引"。**无法裁决**；稳妥做法：标题+属性放满关键词，描述自然写入作备份
- **Hashtag 已失效**：[SelSup 实测（2026-07）](https://selsup.ru/blog/kak-heshtegi-na-ozon-bolshe-ne-vliyayut-na-poisk-i-chto-eto-znachit-dlya-seo-kartochek/)：hashtag 字段不再被搜索索引，仅用户输入带 `#` 精确词才出集合页，只剩导航价值
- **关键词位置**：放标题前部更有效；同一词出现 ≥3 次判堆砌降权；标题建议 40–80 字符
- **属性填满**：属性同时影响文本相关性+过滤器入围+content-рейтинг（重要属性填 >70% 拿满 30 分，总分目标 ≥80）；确定被索引且无堆砌惩罚
- **量化系数**（[sellermoon 汇总](https://sellermoon.ru/faq/ozon/princip-raboty-poiska)，非官方）：评分最高 +25%；配送 ≤2 天加权、>3 天降权；物流加速 +25~32.5%；价格指数 +5~12.5%；折扣最高 +10%

### 3. 广告与自然排名

2025-06 统一公式后广告只是乘数，不能替代有机分；2025-09-01 起 Трафареты 与 Вывод в топ 合并为"Оплата за клик"。间接路径：广告带订单 → 转化率和销量累积 → 有机排名上升；转化差的卡投放反而烧预算。

### 4. OE 件号类产品落地建议（真实 listing 验证）

Ozon 汽配类目官方支持按件号/VIN 搜索（[官方新闻](https://seller.ozon.ru/media/news/avtotovary-zapustili-poisk-po-vin/)）。真实在售 listing 做法一致——件号放标题**末尾**：
- "Ремкомплект карбюратора для ПЛМ YAMAHA 40 л.с. 66T-W0093-01"（[ozon 商品](https://www.ozon.ru/product/remkomplekt-karbyuratora-dlya-plm-yamaha-40-l-s-66t-w0093-01-901314556/)）
- "…для Yamaha 40X, E40X, OEM 66T-W0093-00"（[ozon 商品](https://www.ozon.ru/product/remkomplekt-karbyuratora-skipper-dlya-yamaha-40x-e40x-oem-66t-w0093-00-1089384471/)）

**标题公式**：`俄语品类词 + для + 品牌/机型/马力 + OEM 件号`
**交叉件号**：所有 cross-reference（Yamaha/Parsun/海的/Hidea 兼容件号、-00/-01 变体）填进属性（OEM/аналоги/применяемость 字段）和 аннотация，不堆标题；描述里再自然列一遍兼容清单作备份。

---

## 总结：ONZO 行动优先级

1. **站内为王**：71% 用户在 marketplace 内搜索，Ozon 标题公式 + 属性填满 OE/交叉件号是第一优先级（一件号一卡覆盖低频高转化词）
2. **一鱼两吃**：Ozon 商品页被 Yandex（73% 份额）正常收录，做好标题/属性 = 同时拿站内 + 站外搜索流量
3. **站外免费渠道**：VK 社群 + шопсы（官方集成 Ozon）＞ Telegram 自有频道（官方发发帖奖励）＞ Shorts/Клипы 短视频 ＞ Дзен 长文；论坛只能软广养号，Avito 无俄主体进不去
4. **关键词策略**：俄文品类词 + 双语品牌词 + 机型马力 + 拉丁 OE 号；中国车（Haval）配件需求爆发，是增量赛道
