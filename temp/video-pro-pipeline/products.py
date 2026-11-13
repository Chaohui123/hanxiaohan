# -*- coding: utf-8 -*-
# 5 个在售品的内容型视频统一配置(从 188F 已验收管线泛化)
# 每个品: 产品目录 / 5 段俄语配音文案 / 钩子大字 / 4 条字幕 / 3 段 GLM B-roll prompt / 素材图选择
# 事实来源(已核对货源 JSON, 勿凭记忆改):
#   hub6E7  : 6E7-45987-01/-00, Yamaha 9.9/15/20 л.с. 2T   (temp/listing-hub6E7/rich-content.json)
#   carb-kit: 61N-W0093-00, 25-30 л.с. (T30, 2Т)           (temp/copy-carb-kit.json)
#   67F-v2  : 67F-44352-01-00/-00, F75-F100 4Т             (temp/copy-impellers.json)
#   f20carb : 65W-W0093-00, F20/F25 4Т                     (temp/copy-f20carb.json)
#   pump61n : 61N-W0078-11, 25-30 л.с. 2T / F20 F25 4Т     (temp/ozon-list-pump61n.cjs)
# 配音红线: Yandex SpeechKit v3 marina+friendly / 零变速 / 先配音定时长再配画面 / 字幕≠逐字

# GLM B-roll prompt 统一后缀: 防 AI 乱码文字与中文水印
SUFFIX = "写实风格,无文字无字幕无水印"

PRODUCTS = {
    # ── 1. MAR-YAM-6E7-01 桨毂衬套(橡胶阻尼套) ─────────────────────────────
    "hub6E7": {
        "dir": "temp/listing-hub6E7",               # 产品素材目录
        # 抠图源用白底实拍(01-main 是设计图卡, 04-photo-1 有供应商 logo, 05-photo-2 干净)
        "main_img": "05-photo-2.jpg",
        "cut_thr": 220,                             # 该图浅灰底(226-248), 阈值降到 220 才连通边界
        "proof_img": "02-fitment.jpg",              # 段4 证明滚动图(OE 件号表)
        "cover_img": "00-main-1200.jpg",            # 段5 CTA 封面(设计主图卡)
        "hook_big": ["Винт крутится,", "а лодка стоит?"],   # 段1 大字(最多两行)
        "sub2": "Демпфер ступицы винта 6E7",        # 段2 产品卡旁字幕
        "sub3": "9.9–20 л.с. · 6E7-45987-01",       # 段3 只放数字卖点
        "sub4": "Штатные размеры",                  # 段4 极简
        "sub5": "Гарантия 1 год",
        "vo": [
            "Винт крутится, а лодка стоит?",
            "Демпфер ступицы винта. Гасит удар, защищает редуктор.",
            "Для Yamaha от десяти до двадцати лошадиных сил.",
            "Замена по штатным размерам.",
            "Гарантия 1 год. Заказывайте!",
        ],
        "broll": [
            ("broll1-hook.mp4",
             "夏日湖面,一艘小船的船外机螺旋桨在水中空转搅起水花,船却停在原地不动,"
             "中年渔民困惑地回头查看发动机,紧张氛围," + SUFFIX),
            ("broll2-gen.mp4",
             "船外机螺旋桨在清澈湖水中匀速转动,水流和气泡,夏季晴天,产品摄影,"
             "镜头缓慢推近," + SUFFIX),
            ("broll3-gas.mp4",
             "小船在开阔湖面上加速前行,船外机螺旋桨搅出白色尾迹,夏季晴天,"
             "阳光明亮," + SUFFIX),
        ],
    },
    # ── 2. MAR-YAM-61N-01 化油器修理包(25-30 л.с. 2T) ─────────────────────
    "carb-kit": {
        "dir": "temp/listing-carb-kit",
        "main_img": "05-photo-kit.jpg",             # 白底实拍套件(抠图做产品卡)
        "proof_img": "03-contents.jpg",
        "cover_img": "01-main.jpg",                 # 设计主图卡做 CTA 封面
        "hook_big": ["Мотор глохнет?", "Не заводится?"],
        "sub2": "Ремкомплект карбюратора 61N",
        "sub3": "Аналог 61N-W0093-00",
        "sub4": "Полный комплект",
        "sub5": "Гарантия 1 год",
        "vo": [
            "Мотор глохнет? Не заводится?",
            "Ремкомплект карбюратора. Полный набор для переборки.",
            "Аналог штатного комплекта. Установка без доработок.",
            "Всё в комплекте.",
            "Гарантия 1 год. Заказывайте!",
        ],
        "broll": [
            ("broll1-hook.mp4",
             "夏日湖边,渔民反复用力拉船外机的启动绳,发动机无法启动,渔民表情沮丧,"
             "湖面平静,紧张氛围," + SUFFIX),
            ("broll2-gen.mp4",
             "船外机在船尾平稳运转,湖面泛起波纹,夏季晴天,镜头缓慢推近,产品摄影," + SUFFIX),
            ("broll3-gas.mp4",
             "小船载着渔民在开阔湖面上快速行驶,船外机水花飞溅,夏季晴天," + SUFFIX),
        ],
    },
    # ── 3. MAR-YAM-67F-02 水泵叶轮(F75-F100 4T) ───────────────────────────
    "67F-v2": {
        "dir": "temp/listing-67F-v2",
        # photo-1/2 有 "AMIC Marine 尧疆橡塑" 中文水印(红线: 无中文水印), 13277853678 干净
        "main_img": "13277853678.jpg",
        "proof_img": "03-specs.jpg",
        "cover_img": "00-main-1200.jpg",
        "hook_big": ["Мотор перегревается?", "Нет воды?"],
        "sub2": "Крыльчатка помпы 67F",
        "sub3": "67F-44352-01 · F75–F100",
        "sub4": "Штатные размеры",
        "sub5": "Гарантия 1 год",
        "vo": [
            "Мотор перегревается? Нет воды?",
            "Крыльчатка помпы. Меняйте каждый сезон.",
            "Для моторов от F75 до F100.",
            "Замена по штатным размерам.",
            "Гарантия 1 год. Заказывайте!",
        ],
        "broll": [
            ("broll1-hook.mp4",
             "夏日湖面,船外机发动机过热冒起白色蒸汽,渔民焦急地俯身查看发动机,"
             "紧张氛围," + SUFFIX),
            ("broll2-gen.mp4",
             "船外机水泵冷却水从发动机排水口清澈流出,特写镜头,湖面背景,夏季晴天,"
             "产品摄影," + SUFFIX),
            ("broll3-gas.mp4",
             "船外机强劲运转,冷却水稳定喷出,小船在波光粼粼的湖面平稳巡航,"
             "夏季晴天," + SUFFIX),
        ],
    },
    # ── 4. MAR-YAM-F20-CARB-01 化油器修理包 4T(F20/F25) ───────────────────
    "f20carb": {
        "dir": "temp/listing-f20carb",
        # photo-kit-alt/img01-clean 有 Equus Ferus 水印; split-src-clean.png 白底无水印
        "main_img": "split-src-clean.png",
        "proof_img": "03-contents.jpg",
        "cover_img": "01-main.jpg",                 # 00-main-1200 是带水印供应商原图, CTA 用设计主图卡
        "hook_big": ["Мотор глохнет", "на холостом?"],
        "sub2": "Ремкомплект карбюратора F20/F25",
        "sub3": "Аналог 65W-W0093-00",
        "sub4": "Полный комплект",
        "sub5": "Гарантия 1 год",
        "vo": [
            "Мотор глохнет на холостом?",
            "Ремкомплект карбюратора. Для четырёхтактных F20 и F25.",
            "Аналог штатного комплекта. Установка без доработок.",
            "Всё в комплекте.",
            "Гарантия 1 год. Заказывайте!",
        ],
        "broll": [
            ("broll1-hook.mp4",
             "夏日码头边,船外机怠速运转时突然抖动熄火,渔民皱着眉头重新拉动启动绳,"
             "湖面平静,紧张氛围," + SUFFIX),
            ("broll2-gen.mp4",
             "四冲程船外机在小船船尾平稳怠速运转,湖面平静,夏季晴天,镜头缓慢推近,"
             "产品摄影," + SUFFIX),
            ("broll3-gas.mp4",
             "小船在湖面低速平稳巡航,渔民悠闲垂钓,船外机运转安静平稳,夏季晴天,"
             "阳光明亮," + SUFFIX),
        ],
    },
    # ── 5. MAR-PUMP-61N-01 水泵修理包含壳 ──────────────────────────────────
    "pump61n": {
        "dir": "temp/listing-pump61n",
        "main_img": "photo-kit.jpg",                # 白底实拍套件(抠图做产品卡)
        "proof_img": "03-contents.jpg",
        "cover_img": "00-main-1200.jpg",            # 设计主图卡做 CTA 封面
        "hook_big": ["Мотор перегревается?", "Струя слабая?"],
        "sub2": "Ремкомплект помпы с корпусом",
        "sub3": "61N-W0078-11 · с корпусом",
        "sub4": "Полный комплект",
        "sub5": "Гарантия 1 год",
        "vo": [
            "Мотор перегревается? Струя слабая?",
            "Ремкомплект помпы с корпусом. Ремонт быстрее и надёжнее.",
            "Корпус, крыльчатка и прокладки в одном наборе.",
            "Всё в комплекте.",
            "Гарантия 1 год. Заказывайте!",
        ],
        "broll": [
            ("broll1-hook.mp4",
             "夏日湖面,船外机冷却水出水口水流很弱断断续续,渔民俯身担心地查看发动机,"
             "紧张氛围," + SUFFIX),
            ("broll2-gen.mp4",
             "船外机水泵冷却水强劲稳定地从出水口喷出,特写镜头,湖面背景,夏季晴天,"
             "产品摄影," + SUFFIX),
            ("broll3-gas.mp4",
             "船外机全速运转推动小船在湖面破浪前行,水花飞溅,渔民神情轻松,"
             "夏季晴天," + SUFFIX),
        ],
    },
    # ── 6. MOT-CARB-PZ30-01 PZ30B 化油器带加速泵(牵引车场景) ───────────────
    "pz30": {
        "dir": "temp/listing-pz30/output",
        "main_img": "01-main.jpg",                  # 白底主图(抠图做产品卡)
        "proof_img": "03-fitment.jpg",              # 适配对照图(段4 滚动)
        "cover_img": "08-cover.jpg",                # 封面(CTA)
        "hook_big": ["Мотобуксировщик", "не тянет?"],
        "sub2": "Карбюратор PZ30 с насосом",
        "sub3": "200-250сс · 7-15 л.с.",
        "sub4": "Полный комплект",
        "sub5": "Гарантия 1 год",
        "vo": [
            "Мотобуксировщик не тянет?",
            "Карбюратор ПЗ30 с ускорительным насосом.",
            "Отклик на газ без провалов.",
            "Замена по штатным точкам.",
            "Гарантия 1 год. Заказывайте!",
        ],
        "broll": [
            ("broll1-hook.mp4",
             "冬季雪地,一台摩托牵引车拉着爬犁陷在雪里吃力不动,车主俯身检查发动机,"
             "紧张氛围," + SUFFIX),
            ("broll2-gen.mp4",
             "摩托牵引车在开阔雪地上平稳行驶,履带卷起雪雾,冬季晴天,产品摄影,"
             "镜头缓慢推近," + SUFFIX),
            ("broll3-gas.mp4",
             "摩托牵引车拉着满载爬犁在雪地上顺畅加速行驶,雪雾飞扬,冬季晴天,"
             "阳光明亮," + SUFFIX),
        ],
    },
    # ── 7. GEN-BELT-33X14-01 雪地摩托 CVT 变速皮带 33x14-1120 ───────────────
    # 钩子：皮带断裂痛点（Порвался ремень вариатора?）；主打 Буран 2Т/Рысь/мотобуксировщик
    "belt33x14": {
        "dir": "temp/listing-33x14/output",
        "main_img": "01-main.jpg",                  # 白底主图(抠图做产品卡)
        "proof_img": "03-fitment.jpg",              # 适配对照图(段4 滚动)
        "cover_img": "08-cover.jpg",                # 封面(CTA)
        "hook_big": ["Порвался ремень", "вариатора?"],
        "sub2": "Ремень вариатора 33x14-1120",
        "sub3": "33 × 14 × 1120 мм",
        "sub4": "Сверьте размер",
        "sub5": "Гарантия 1 год",
        "vo": [
            "Порвался ремень вариатора?",
            "Ремень 33 на 14, длина 1120. Для снегохода и мотобуксировщика.",
            "Точный размер: ширина 33, толщина 14, длина 1120 миллиметров.",
            "Сверьте маркировку со старым ремнём.",
            "Гарантия 1 год. Заказывайте!",
        ],
        "broll": [
            ("broll1-hook.mp4",
             "冬季雪原,一台履带雪地摩托陷在雪里无法动弹,车主打开引擎盖发现断裂的皮带,"
             "表情懊恼,紧张氛围," + SUFFIX),
            ("broll2-gen.mp4",
             "履带雪地摩托在冬季雪原上平稳行驶,履带卷起雪雾,远处泰加林,阴天柔光,"
             "产品摄影,镜头缓慢推近," + SUFFIX),
            ("broll3-gas.mp4",
             "摩托牵引车拉着满载货物的雪橇在雪原上顺畅加速行驶,雪雾飞扬,冬季晴天,"
             "阳光明亮," + SUFFIX),
        ],
    },
    # ── 8. GEN-BELT-35X1126-01 雪地摩托 CVT 皮带 35x1126（Тайга Варяг 550 原配+Viking 540） ──
    "belt35x1126": {
        "dir": "temp/listing-35x1126/output",
        "main_img": "01-main.jpg",                  # 白底主图(抠图做产品卡)
        "proof_img": "03-fitment.jpg",              # 适配对照图(段4 滚动)
        "cover_img": "08-cover.jpg",                # 封面(CTA)
        "hook_big": ["Порвался ремень", "на Тайге 550?"],
        "sub2": "Ремень вариатора 35x1126",
        "sub3": "35 × 1126 мм",
        "sub4": "Сверьте размер",
        "sub5": "Гарантия 1 год",
        "vo": [
            "Порвался ремень на Тайге пятьсот пятидесятой?",
            "Ремень 35 на 1126. Штатный размер Тайги Варяг 550.",
            "Армированный корд. Замена без доработок.",
            "Подходит и для Viking 540 — сверьте маркировку.",
            "Гарантия 1 год. Заказывайте!",
        ],
        "broll": [
            ("broll1-hook.mp4",
             "冬季雪原,一台俄式履带雪地摩托陷在雪里无法动弹,车主打开引擎盖发现断裂的皮带,"
             "表情懊恼,紧张氛围," + SUFFIX),
            ("broll2-gen.mp4",
             "俄式履带雪地摩托在冬季泰加林雪原上平稳行驶,履带卷起雪雾,阴天柔光,"
             "产品摄影,镜头缓慢推近," + SUFFIX),
            ("broll3-gas.mp4",
             "履带雪地摩托在深雪中奋力爬坡前行,雪雾飞扬,冬季晴天,阳光明亮," + SUFFIX),
        ],
    },
    # ── 9. MAR-YAM-61N-CABLE-01 船外机油门拉线 61N-26311-00（25-30 л.с. 2Т，零品牌口径） ──
    "61ncable": {
        "dir": "temp/listing-61ncable/output",
        "main_img": "01-main.jpg",                  # 白底主图(抠图做产品卡)
        "proof_img": "03-fitment.jpg",              # 适配对照图(段4 滚动)
        "cover_img": "08-cover.jpg",                # 封面(CTA)
        "hook_big": ["Заклинил трос газа?", "Трогаетесь рывками?"],
        "sub2": "Трос газа 61N-26311-00",
        "sub3": "25–30 л.с. · 2Т",
        "sub4": "Как у штатного",
        "sub5": "Гарантия 1 год",
        "vo": [
            "Заклинил трос газа? Трогаетесь рывками?",
            "Трос дроссельной заслонки. Плавный ход, точный отклик.",
            "Для лодочных моторов двадцать пять — тридцать лошадиных сил.",
            "Длина — как у штатного троса. Установка без доработок.",
            "Гарантия один год. Заказывайте!",
        ],
        "cut_enclosed": 20000,                  # 抠图: 大于此面积的封闭白区(缆线环孔)也透明化
        "broll": [
            ("broll1-hook.mp4",
             "夏日湖面,一艘小船启动加速时船身明显顿挫颠簸,中年驾驶员皱眉回头查看船外机,"
             "船外机机罩为纯深灰色光滑表面,绝对没有任何标志、贴纸、文字、图案,"
             "紧张氛围," + SUFFIX),
            ("broll2-gen.mp4",
             "深灰色船外机(舷外机)安装在小型铝制渔船船尾,背景是开阔湖面与远处树林,夏日晴天,"
             "产品摄影,镜头缓慢推近,无任何品牌标志," + SUFFIX),
            ("broll3-gas.mp4",
             "小船在开阔湖面上平稳加速前行,船外机拖出均匀白色尾迹,夏日晴天,阳光明亮," + SUFFIX),
        ],
    },
    # ── 11. CN-AUTO-GRILLE-COVER-01 汽车水箱保温罩（冬季格栅挡风保温罩，通用 100×70，零品牌口径） ──
    "grillecover": {
        "dir": "temp/listing-grillecover/output",
        "main_img": "01-main.jpg",                  # 白底主图(抠图做产品卡)
        "proof_img": "04-size.jpg",                 # 尺寸适配图(段4 滚动)
        "cover_img": "08-cover.jpg",                # 封面(CTA)
        "hook_big": ["Двигатель долго", "прогревается зимой?"],
        "sub2": "Утеплитель решётки 100×70",
        "sub3": "4 слоя · быстрый прогрев",
        "sub4": "100 × 70 см",
        "sub5": "Гарантия 1 год",
        "vo": [
            "Двигатель долго прогревается зимой? Переплачиваете за бензин?",
            "Утеплитель решётки радиатора. Сто на семьдесят сантиметров.",
            "Двигатель быстрее выходит на рабочую температуру — меньше расход на прогрев.",
            "Установка за две минуты на вшитые крючки. Подходит большинству авто.",
            "Гарантия один год. Заказывайте!",
        ],
        "broll": [
            ("broll1-hook.mp4",
             "冬季清晨居民区街道,一辆覆盖薄雪的家用汽车停在路边,车主坐进驾驶室呼出白气,"
             "车窗结霜,车主无奈地看着窗外等待,车身无任何标志无车牌无文字,"
             "紧张氛围," + SUFFIX),
            ("broll2-gen.mp4",
             "冬季清晨特写,一只戴厚手套的手用雪刷清扫汽车挡风玻璃上的积雪与冰霜,"
             "雪粒飞溅,画面只见到手臂、雪刷与玻璃局部,看不到车身其他部位,"
             "冷色调柔光,产品摄影,镜头缓慢推近," + SUFFIX),
            ("broll3-gas.mp4",
             "冬季晴天公路,一辆汽车在积雪的郊区公路上平稳行驶,排气管飘出淡淡白雾,"
             "阳光明亮,车身无标志无车牌," + SUFFIX),
        ],
    },
    # ── 12. MOT-MIK-VM34-KIT-01 化油器修理包 VM30/32/34（Буран/Тайга 雪地摩托，零 Mikuni 口径） ──
    "vm34kit": {
        "dir": "temp/listing-vm34kit/output",
        "main_img": "01-main.jpg",                  # 白底主图(抠图做产品卡)
        "proof_img": "03-fitment.jpg",              # 适配对照图(段4 滚动)
        "cover_img": "08-cover.jpg",                # 封面(CTA)
        "hook_big": ["Снегоход не заводится", "после лета?"],
        "sub2": "Ремкомплект VM30/32/34",
        "sub3": "12 предметов",
        "sub4": "Буран · Тайга",
        "sub5": "Гарантия 1 год",
        "vo": [
            "Снегоход не заводится после лета? Пора ремонтировать карбюратор!",
            "Ремкомплект для карбюраторов вэ-эм тридцать, тридцать два, тридцать четыре.",
            "Двенадцать предметов: прокладки, кольца, игольчатый клапан и распылитель.",
            "Для снегоходов Буран и Тайга. Установка по штатным местам.",
            "Гарантия один год. Заказывайте!",
        ],
        "cut_enclosed": 20000,                  # 抠图: 垫片镂空白区(>此面积)也透明化(61ncable 环孔先例)
        "broll": [
            ("broll1-hook.mp4",
             "冬季清晨,一辆老式雪地摩托停在积雪的车库前,中年驾驶员穿着厚外套多次用力拉动启动绳,"
             "发动机无法启动,驾驶员呼出白气无奈摇头,雪地摩托车身为纯深绿色光滑表面,"
             "车身侧面完全是纯色没有任何字母,绝对没有任何标志、贴纸、文字、图案、印花,"
             "紧张氛围," + SUFFIX),
            ("broll2-gen.mp4",
             "特写:一双戴工作手套的手在木工作台上拆解小型圆形化油器,旁边整齐摆放黑色垫片、"
             "红色垫圈与黄铜小零件,冬季车间暖色灯光,产品摄影,镜头缓慢推近,"
             "画面中没有任何文字、标签、标志," + SUFFIX),
            ("broll3-gas.mp4",
             "冬季晴天,一辆老式雪地摩托在开阔粉雪雪原上平稳加速驶过,雪雾飞扬,"
             "远处白桦树林,阳光明亮,车身为纯深色无任何标志无文字," + SUFFIX),
        ],
    },
    # ── 13. MOT-168F-CLUTCH-01 168F/170F 牵引车离合器碟片组（双A70 芯+罩，零 Lifan 口径） ──
    "168fclutch": {
        "dir": "temp/listing-168fclutch/output",
        "main_img": "01-main.jpg",                  # 白底主图(抠图做产品卡)
        "proof_img": "03-fitment.jpg",              # 适配对照图(段4 滚动)
        "cover_img": "08-cover.jpg",                # 封面(CTA)
        "hook_big": ["Сцепление буксует", "под нагрузкой?"],
        "sub2": "Комплект сцепления 168F/170F",
        "sub3": "Вал 20 мм · шпонка 5",
        "sub4": "Блок + кожух",
        "sub5": "Гарантия 1 год",
        "vo": [
            "Сцепление буксует под нагрузкой? Техника трогается рывками?",
            "Комплект центробежного сцепления. Двигатели серий сто шестьдесят восемь — сто семьдесят.",
            "Блок сцепления с тремя колодками и кожух со шкивом семьдесят миллиметров.",
            "Посадка на вал двадцать миллиметров, шпонка пять. Установка без доработок.",
            "Гарантия один год. Заказывайте!",
        ],
        "cut_enclosed": 20000,                  # 抠图: 轴芯孔封闭白区透明化(61ncable 环孔先例)
        "broll": [
            ("broll1-hook.mp4",
             "冬季雪原特写镜头:一辆履带式雪地牵引车的金属履带在厚雪中空转高速刨雪、雪粒大量飞溅,"
             "画面只看到履带、底盘与卷起的雪雾局部,看不到车身侧板与车顶,背景虚化的冬日雪原,"
             "冷色调,画面绝对是纯机械局部特写,没有任何文字、字母、标志、贴纸、印花、图案,"
             "紧张氛围," + SUFFIX),
            ("broll2-gen.mp4",
             "特写:一双戴工作手套的手在木工作台上把圆形金属离心离合器芯装入绿色圆形离合器外罩,"
             "旁边放一把扳手,冬季车间暖色灯光,产品摄影,镜头缓慢推近,"
             "画面中没有任何文字、标签、标志," + SUFFIX),
            ("broll3-gas.mp4",
             "冬季晴天,一辆小型履带式雪地牵引车拖着空雪橇在开阔雪原上平稳行驶,"
             "雪雾轻扬,远处白桦树林,阳光明亮,车身为纯深色无任何标志无文字," + SUFFIX),
        ],
    },
    # ── 12. CN-DASHCOVER-JOLION-01 仪表台避光垫（专版裁剪，无抬显黑边，零品牌口径） ──
    "dashcover": {
        "dir": "temp/listing-dashcover/output",
        "main_img": "01-main.jpg",                  # 安装图主图(产品卡)
        "proof_img": "04-fitment.jpg",              # 适配核对图(段4 滚动)
        "cover_img": "08-cover.jpg",                # 封面(CTA)
        "hook_big": ["Панель трескается", "от солнца?"],
        "sub2": "Накидка на торпедо",
        "sub3": "Точный крой · без бликов",
        "sub4": "Левый руль · без HUD",
        "sub5": "Гарантия 1 год",
        "vo": [
            "Панель трескается от солнца? Блики мешают вести?",
            "Накидка на торпедо. Точный крой под вашу панель.",
            "Матовый микровелюр — нет бликов, панель не выгорает.",
            "Установка за одну минуту без клея. Не скользит, не пахнет.",
            "Гарантия один год. Заказывайте!",
        ],
        "broll": [
            ("broll1-hook.mp4",
             "特写镜头:汽车黑色仪表台表面在阳光下暴晒,表面出现细微裂纹与褪色,"
             "强烈阳光从挡风玻璃射入产生刺眼眩光,画面只见仪表台局部,无方向盘无车标无文字,"
             "紧张氛围," + SUFFIX),
            ("broll2-gen.mp4",
             "汽车驾驶舱内,从副驾驶侧斜向拍摄仪表台台面与挡风玻璃下沿局部,"
             "黑色仪表台干净空旷,柔和日光,画面不出现方向盘与中控屏,无任何标志文字,"
             "产品摄影,镜头缓慢推近," + SUFFIX),
            ("broll3-gas.mp4",
             "特写:一只戴手套的手从汽车仪表台上轻轻抚过,台面干净平整,"
             "柔和阳光从挡风玻璃照入,画面只见手与仪表台局部,无标志无文字,"
             "温馨氛围," + SUFFIX),
        ],
    },
    # ── 14. CN-AUTO-GLP-12V/24V-01 点火塞 v2（英文 prompt，零车标/零人脸/零产品实物口径） ──
    "glowplug": {
        "dir": "temp/listing-glowplug",
        "broll": [
            ("qingying-open-frost.mp4",
             "View from inside a car on an early winter morning, looking through the front "
             "windshield covered with delicate frost crystal patterns, cold blue dawn light, "
             "an empty snow-covered yard outside, no people, no faces, no logos, no brand "
             "emblems, no text, no watermark, plain unmarked interior, cinematic "
             "photorealistic, slow subtle camera drift"),
            ("qingying-compare-cold.mp4",
             "Dim cold vehicle cabin interior at winter dawn seen from the passenger side, "
             "gray fabric seats, frosted side window, cold blue-gray tones, faint breath "
             "vapor in the air, no people, no faces, no logos, no brand emblems, no text, "
             "no watermark, moody cinematic light, static camera with slight drift"),
            ("qingying-compare-warm.mp4",
             "Winter highway stretching ahead at sunrise, warm orange sunlight flooding the "
             "empty road, light snow on the roadside, clear sky with soft clouds, smooth "
             "slow forward camera glide, no vehicles, no people, no road signs, no text, "
             "no logos, no watermark, cinematic photorealistic"),
            ("qingying-workbench.mp4",
             "Top-down view of a tidy wooden workbench: a single plain steel combination "
             "wrench and a pair of dark fabric work gloves lying flat side by side, clearly "
             "separated, both objects fully formed and sharply in focus, soft warm workshop "
             "lighting, slow gentle camera push-in, no hands, no people, no text, no "
             "engravings, no brand marks on the tools, no watermark, photorealistic"),
            ("qingying-workbench-v2.mp4",
             "Top-down view of a tidy wooden workbench: a single polished steel combination "
             "wrench with a completely smooth blank handle, absolutely no markings, no "
             "engravings, no letters, no numbers on the metal surface, next to a pair of "
             "plain dark fabric work gloves lying flat, clearly separated, soft warm "
             "workshop lighting, slow gentle camera push-in, no hands, no people, no text, "
             "no watermark, photorealistic"),
            ("qingying-road-sunrise.mp4",
             "Empty winter country road at golden sunrise, sun low on the horizon, "
             "snow-covered fields on both sides, a few bare trees, warm golden light mixed "
             "with cool blue shadows, slow cinematic forward glide, no vehicles, no people, "
             "no road signs, no text, no logos, no watermark, photorealistic"),
        ],
    },
}

# 品顺序(批量脚本按此跑)
ORDER = ["hub6E7", "carb-kit", "67F-v2", "f20carb", "pump61n"]
