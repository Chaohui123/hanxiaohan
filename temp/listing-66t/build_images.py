# -*- coding: utf-8 -*-
"""
ONZO · 66T-W0093-00/01 化油器修理包 Ozon 图集生成器
4 张信息图 750x1000 (3:4, 版式与 61N 差异化) + 4 张实拍副图 1200x1200
素材: temp/src-assets/carb-66t-yamarui/1688_608822032027/images/
  img_01.webp 全家福横排 -> 主图英雄 + 垫片/膜片/螺丝/大O环裁片
  img_03.webp 全家福竖排 -> 05 实拍 (与 01 摆位不同, 防判重)
  img_04.webp 零件矩阵   -> 02 照片卡 + 03 浮子/针阀卡 + 06/08 特写裁片
  img_02.webp 分组摆拍   -> 07 五金双裁片
  img_06/07 满屏水印包装纸背景 -> 弃; img_08-13 低分辨率缩略图 -> 弃
品牌处理: 5 张 webp 同模板, YAMARINE 标固定在 y<148 纯白带 (产品区 y>=230),
  整带矩形白化 + 残留暗像素扫描断言
与 61N 差异化: 主色 藏青+橙 -> 深青+红; 01 顶部色带+双胶囊 -> 无带大标题+底部色带;
  02 左右双列 -> 通栏OE面板+三卡行; 03 2x3网格 -> 3x2网格+标签条;
  04 深底2x2图标 -> 浅底横向列表行
红线: 零中文 / 零水印 / 零裁切(产品完整) / 不编规格数字 / 禁 Yamaha 品牌词(67F 教训)
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

SRC = "temp/src-assets/carb-66t-yamarui/1688_608822032027/images"
ROOT_DIR = "temp/listing-66t"
OUT_DIR = os.path.join(ROOT_DIR, "output")
ASSETS = os.path.join(ROOT_DIR, "_assets")
FB = "C:/Windows/Fonts/arialbd.ttf"
FR = "C:/Windows/Fonts/arial.ttf"
S = 2                      # 超采样
W, H = 750 * S, 1000 * S   # 信息图画布 1500x2000

TEAL = (9, 84, 82)
TEAL_D = (5, 55, 54)
INK = (31, 41, 49)
GRAY = (106, 117, 128)
LGRAY = (240, 243, 245)
RED = (202, 54, 44)
RED_D = (148, 34, 27)
TINT = (253, 240, 238)
WHITE = (255, 255, 255)

BANNED = ("оригинал", "yamaha")

def T(s):
    low = s.lower()
    for b in BANNED:
        assert b not in low, f"禁用词命中: {b} in {s}"
    return s

_fonts = {}
def font(bold, size):
    key = (bold, int(size))
    if key not in _fonts:
        _fonts[key] = ImageFont.truetype(FB if bold else FR, int(size))
    return _fonts[key]

def fit_font(draw, text, bold, max_w, start, min_s=20):
    s = start
    while s > min_s and draw.textlength(text, font=font(bold, s)) > max_w:
        s -= 2
    return font(bold, s)

def wrap(draw, text, f, max_w):
    words, lines, cur = text.split(), [], ""
    for wd in words:
        t = (cur + " " + wd).strip()
        if draw.textlength(t, font=f) <= max_w:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = wd
    if cur:
        lines.append(cur)
    return lines

def vgrad(w, h, top, bottom):
    base = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / max(1, h - 1)
        base.putpixel((0, y), tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return base.resize((w, h))

def text_center(draw, cx, y, text, f, fill):
    tw = draw.textlength(text, font=f)
    draw.text((cx - tw / 2, y), text, font=f, fill=fill)
    return f.size

def rounded(draw, box, r, **kw):
    draw.rounded_rectangle(box, radius=r, **kw)

# ---------------------------------------------------------------- 素材准备
def whiten_brand(im, name):
    """YAMARINE 品牌带固定在 y<148 (纯白墙区, 产品区 y>=230): 整带白化 + 残留扫描"""
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, im.width, 148], fill=(255, 255, 255))
    px = im.load()
    bad = 0
    for y in range(150):
        for x in range(im.width):
            p = px[x, y]
            if (p[0] * 299 + p[1] * 587 + p[2] * 114) // 1000 < 200:
                bad += 1
    print(f"[whiten] {name}: 带内残留暗像素 = {bad}")
    assert bad == 0, f"{name}: 品牌带白化后仍有 {bad} 个暗像素残留"
    return im

def prep_assets():
    os.makedirs(ASSETS, exist_ok=True)
    im01 = whiten_brand(Image.open(os.path.join(SRC, "img_01.webp")).convert("RGB"), "img_01")
    im03 = whiten_brand(Image.open(os.path.join(SRC, "img_03.webp")).convert("RGB"), "img_03")
    im04 = whiten_brand(Image.open(os.path.join(SRC, "img_04.webp")).convert("RGB"), "img_04")
    im05 = whiten_brand(Image.open(os.path.join(SRC, "img_05.webp")).convert("RGB"), "img_05")

    # 主图全家福 (img_01 横排, 全件完整 y240-1090)
    im01.crop((60, 150, 1210, 1150)).save(os.path.join(ASSETS, "kit_full.png"))
    # 05 实拍全家福 (img_03 竖排, 仅去品牌带, 不切产品)
    im03.crop((0, 150, 1271, 1271)).save(os.path.join(ASSETS, "kit_vert.png"))
    # 03 网格卡裁片
    im04.crop((820, 285, 1085, 565)).save(os.path.join(ASSETS, "gasket.png"))        # 大垫片 (img_04 右上, 独立干净)
    im01.crop((740, 780, 1030, 1040)).save(os.path.join(ASSETS, "diaphragm.png"))   # 灰膜片
    im04.crop((735, 790, 915, 970)).save(os.path.join(ASSETS, "float.png"))         # 浮子
    # 针阀+铜钉量孔 cluster: img_04 两处干净小裁片白底拼合
    cluster = Image.new("RGB", (330, 200), (255, 255, 255))
    cluster.paste(im04.crop((225, 548, 310, 738)), (12, 5))      # 针阀 (含黑色尖头, 完整)
    cluster.paste(im04.crop((775, 545, 1000, 730)), (102, 8))    # 怠速铜钉+主量孔
    cluster.save(os.path.join(ASSETS, "needle.png"))
    im01.crop((668, 545, 1070, 720)).save(os.path.join(ASSETS, "screws.png"))       # 螺丝排+弹垫 (底边留足, 不切螺丝尖)
    # 02 照片卡: 黑垫片 (img_04 右上)
    im04.crop((825, 290, 1080, 560)).save(os.path.join(ASSETS, "gasket_card.png"))
    # 06 垫片+膜片横带 (img_04 上排四件; 底边 556 避开下排针阀顶)
    im04.crop((185, 282, 1085, 556)).save(os.path.join(ASSETS, "gasket_strip.png"))
    # 07 五金: 左=img_04 针阀+垫圈排, 右=复用 screws.png
    im04.crop((225, 545, 615, 745)).save(os.path.join(ASSETS, "hw_needle.png"))
    # 08 大O环 (img_05 左环, 独立无邻件)
    im05.crop((295, 535, 515, 755)).save(os.path.join(ASSETS, "oring.png"))
    print("[assets] prepared ->", ASSETS)

def A(name):
    return Image.open(os.path.join(ASSETS, name)).convert("RGB")

def fit_into(canvas, img, box, bg=WHITE, shadow=False):
    """把 img 等比放进 box (x0,y0,x1,y1)@超采样坐标, 白底, 不变形"""
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0, y1 - y0
    r = min(bw / img.width, bh / img.height)
    nw, nh = max(1, int(img.width * r)), max(1, int(img.height * r))
    im = img.resize((nw, nh), Image.LANCZOS)
    if shadow:
        sh = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        sd = ImageDraw.Draw(sh)
        sd.ellipse([x0 + bw * 0.12, y1 - 14 * S, x1 - bw * 0.12, y1 + 10 * S],
                   fill=(0, 0, 0, 46))
        sh = sh.filter(ImageFilter.GaussianBlur(8 * S))
        canvas.paste(sh, (0, 0), sh)
    canvas.paste(im, (x0 + (bw - nw) // 2, y0 + (bh - nh) // 2))

def save_pair(img, name):
    img = img.resize((750, 1000), Image.LANCZOS)
    img.save(os.path.join(OUT_DIR, name + ".png"))
    img.save(os.path.join(OUT_DIR, name + ".jpg"), quality=92)
    print("[build]", name)

def save_photo(canvas1200, name):
    canvas1200.save(os.path.join(OUT_DIR, name + ".jpg"), quality=92)
    print("[build]", name)

# ---------------------------------------------------------------- 01 主图 (无带大标题 + 底部色带)
def build_01():
    c = Image.new("RGB", (W, H), WHITE)
    d = ImageDraw.Draw(c)
    # 顶部红色 kicker
    f_k = font(True, 24 * S)
    text_center(d, W // 2, 50 * S, T("АНАЛОГ 66T-W0093-00 · 66T-W0093-01"), f_k, RED)
    # 大标题两行
    f_t = fit_font(d, T("РЕМКОМПЛЕКТ"), True, W - 80 * S, 84 * S)
    text_center(d, W // 2, 96 * S, T("РЕМКОМПЛЕКТ"), f_t, INK)
    text_center(d, W // 2, 96 * S + f_t.size + 8 * S, T("КАРБЮРАТОРА"), f_t, INK)
    # 副标
    f_s = font(False, 27 * S)
    text_center(d, W // 2, 96 * S + f_t.size * 2 + 34 * S,
                T("для лодочных моторов 40 л.с. · 2-тактных"), f_s, GRAY)
    # 中部产品全家福
    fit_into(c, A("kit_full.png"), (50 * S, 340 * S, 700 * S, 780 * S), shadow=True)
    d = ImageDraw.Draw(c)
    # 底部通栏深青色带
    band_y = 810 * S
    c.paste(vgrad(W, H - band_y, TEAL, TEAL_D), (0, band_y))
    d = ImageDraw.Draw(c)
    f_m = fit_font(d, T("40X / E40X"), True, 330 * S, 58 * S)
    d.text((62 * S, 852 * S), T("40X / E40X"), font=f_m, fill=WHITE)
    f_sb = font(False, 25 * S)
    d.text((62 * S, 852 * S + f_m.size + 20 * S), T("40 л.с. · 2-тактный"),
           font=f_sb, fill=(186, 214, 212))
    # 右侧红色徽章胶囊
    txt = T("ПОЛНЫЙ НАБОР")
    f_b = font(True, 27 * S)
    tw = d.textlength(txt, font=f_b)
    pw, ph = tw + 60 * S, 66 * S
    cx, cy = 562 * S, 872 * S
    rounded(d, [cx - pw / 2, cy, cx + pw / 2, cy + ph], ph / 2, fill=RED)
    d.text((cx - tw / 2, cy + (ph - f_b.size) / 2 - 3 * S), txt, font=f_b, fill=WHITE)
    save_pair(c, "01-main")

# ---------------------------------------------------------------- 02 适配表 (通栏OE面板 + 三卡行)
def build_02():
    c = Image.new("RGB", (W, H), WHITE)
    d = ImageDraw.Draw(c)
    fh = font(True, 42 * S)
    d.text((50 * S, 52 * S), T("СОВМЕСТИМОСТЬ"), font=fh, fill=INK)
    d.rectangle([50 * S, 116 * S, 140 * S, 122 * S], fill=RED)
    # 通栏 OE 深青面板
    rounded(d, [50 * S, 150 * S, 700 * S, 352 * S], 18 * S, fill=TEAL)
    f_lab = font(False, 21 * S)
    d.text((80 * S, 172 * S), T("АНАЛОГ НОМЕРОВ OE"), font=f_lab, fill=(170, 200, 198))
    f_oe = fit_font(d, "66T-W0093-00", True, 560 * S, 42 * S)
    d.text((80 * S, 204 * S), "66T-W0093-00", font=f_oe, fill=WHITE)
    d.text((80 * S, 204 * S + f_oe.size + 10 * S), "66T-W0093-01", font=f_oe, fill=WHITE)
    f_sub = font(False, 21 * S)
    d.text((80 * S, 204 * S + f_oe.size * 2 + 32 * S),
           T("ремкомплект карбюратора 66T-14301-02"), font=f_sub, fill=(170, 200, 198))
    # 三卡行: 40X / E40X / 垫片照片卡
    cw, ch, gap = 206 * S, 258 * S, 16 * S
    y0 = 386 * S
    for i in range(3):
        x0 = 50 * S + i * (cw + gap)
        rounded(d, [x0, y0, x0 + cw, y0 + ch], 16 * S, fill=LGRAY)
    for i, model in enumerate(("40X", "E40X")):
        x0 = 50 * S + i * (cw + gap)
        ccx, ccy, cr = x0 + cw // 2, y0 + 52 * S, 27 * S
        d.ellipse([ccx - cr, ccy - cr, ccx + cr, ccy + cr], fill=RED)
        d.line([(ccx - 12 * S, ccy + 1 * S), (ccx - 3 * S, ccy + 11 * S)],
               fill=WHITE, width=6 * S)
        d.line([(ccx - 3 * S, ccy + 11 * S), (ccx + 14 * S, ccy - 11 * S)],
               fill=WHITE, width=6 * S)
        f_m = fit_font(d, model, True, cw - 40 * S, 46 * S)
        text_center(d, x0 + cw // 2, y0 + 96 * S, model, f_m, TEAL)
        f_p = font(False, 21 * S)
        text_center(d, x0 + cw // 2, y0 + 96 * S + f_m.size + 16 * S,
                    T("40 л.с."), f_p, INK)
        text_center(d, x0 + cw // 2, y0 + 96 * S + f_m.size + 46 * S,
                    T("2-тактный"), f_p, GRAY)
    # 照片卡
    x0 = 50 * S + 2 * (cw + gap)
    fit_into(c, A("gasket_card.png"), (x0 + 12 * S, y0 + 12 * S, x0 + cw - 12 * S, y0 + ch - 66 * S))
    d = ImageDraw.Draw(c)
    f_cap = font(False, 18 * S)
    for j, ln in enumerate(wrap(d, T("прокладка из комплекта"), f_cap, cw - 24 * S)[:2]):
        text_center(d, x0 + cw // 2, y0 + ch - 58 * S + j * 22 * S, ln, f_cap, GRAY)
    # 底部自检条 (红调)
    sy = 692 * S
    rounded(d, [50 * S, sy, 700 * S, 950 * S], 20 * S, fill=TINT)
    d.rectangle([50 * S, sy + 20 * S, 58 * S, 950 * S - 20 * S], fill=RED)
    f_h = font(True, 26 * S)
    d.text((84 * S, sy + 26 * S), T("КАК ПРОВЕРИТЬ ПЕРЕД ЗАКАЗОМ"), font=f_h, fill=RED_D)
    tips = [T("Сверьте номер, нанесённый на корпус вашего"),
            T("карбюратора: если каталог запчастей указывает"),
            T("66T-W0093-00 или 66T-W0093-01 — комплект подходит.")]
    f_b = font(False, 23 * S)
    for i, t in enumerate(tips):
        d.text((84 * S, sy + 72 * S + i * 40 * S), t, font=f_b, fill=INK)
    save_pair(c, "02-fitment")

# ---------------------------------------------------------------- 03 内容物 (3x2 网格 + 标签条)
def build_03():
    c = Image.new("RGB", (W, H), LGRAY)
    d = ImageDraw.Draw(c)
    fh = fit_font(d, T("СОСТАВ КОМПЛЕКТА"), True, W - 100 * S, 44 * S)
    text_center(d, W // 2, 46 * S, T("СОСТАВ КОМПЛЕКТА"), fh, INK)
    f_sub = font(False, 23 * S)
    text_center(d, W // 2, 46 * S + fh.size + 16 * S,
                T("все детали для переборки карбюратора — в одном комплекте"), f_sub, GRAY)
    cards = [
        ("gasket.png", T("Прокладки")),
        ("diaphragm.png", T("Мембрана")),
        ("float.png", T("Поплавок")),
        ("needle.png", T("Игольчатый клапан")),
        ("screws.png", T("Винты и шайбы")),
        (None, None),
    ]
    gx, gy = 36 * S, 188 * S
    cw, ch, gap = 216 * S, 358 * S, 15 * S
    strip = 48 * S
    for i, (img, label) in enumerate(cards):
        col, row = i % 3, i // 3
        x0 = gx + col * (cw + gap)
        y0 = gy + row * (ch + gap)
        if img is None:  # 第 6 格: 深青卖点文字卡
            rounded(d, [x0, y0, x0 + cw, y0 + ch], 16 * S, fill=TEAL)
            f_t = font(True, 23 * S)
            cx = x0 + cw // 2
            text_center(d, cx, y0 + 92 * S, T("Все детали"), f_t, WHITE)
            text_center(d, cx, y0 + 92 * S + 34 * S, T("для переборки"), f_t, WHITE)
            text_center(d, cx, y0 + 92 * S + 68 * S, T("— в одном наборе"), f_t, WHITE)
            f_b = font(False, 19 * S)
            text_center(d, cx, y0 + 232 * S, T("не нужно подбирать детали"), f_b, (176, 204, 202))
            text_center(d, cx, y0 + 232 * S + 28 * S, T("по отдельности"), f_b, (176, 204, 202))
            continue
        rounded(d, [x0, y0, x0 + cw, y0 + ch], 16 * S, fill=WHITE)
        fit_into(c, A(img), (x0 + 12 * S, y0 + 12 * S, x0 + cw - 12 * S, y0 + ch - strip - 8 * S))
        d = ImageDraw.Draw(c)
        # 底部深青标签条 (圆角卡内嵌直条)
        d.rectangle([x0, y0 + ch - strip, x0 + cw, y0 + ch], fill=TEAL)
        d.rectangle([x0, y0 + ch - strip, x0 + cw, y0 + ch - strip + 6 * S], fill=TEAL)
        f_l = fit_font(d, label, True, cw - 20 * S, 20 * S)
        text_center(d, x0 + cw // 2, y0 + ch - strip + (strip - f_l.size) / 2 - 3 * S,
                    label, f_l, WHITE)
    save_pair(c, "03-contents")

# ---------------------------------------------------------------- 04 症状提示 (浅底横向列表行)
def icon(d, kind, cx, cy, r, col):
    """线性图标: idle 转速表 / misfire 脉冲 / fuel 油滴 / stall 电源"""
    lw = max(2, int(5 * S))
    if kind == "idle":
        d.arc([cx - r, cy - r, cx + r, cy + r], 150, 30, fill=col, width=lw)
        import math
        for ang in (170, 210, 250, 290, 330, 10):
            a = math.radians(ang)
            d.line([(cx + (r - 8 * S) * math.cos(a), cy + (r - 8 * S) * math.sin(a)),
                    (cx + r * math.cos(a), cy + r * math.sin(a))], fill=col, width=lw)
        a = math.radians(325)
        d.line([(cx, cy), (cx + (r - 14 * S) * math.cos(a), cy + (r - 14 * S) * math.sin(a))],
               fill=col, width=lw)
    elif kind == "misfire":
        pts = [(cx - r, cy), (cx - r * 0.45, cy), (cx - r * 0.2, cy - r * 0.62),
               (cx + r * 0.1, cy + r * 0.62), (cx + r * 0.3, cy), (cx + r, cy)]
        d.line(pts, fill=col, width=lw, joint="curve")
    elif kind == "fuel":
        d.polygon([(cx, cy - r), (cx + r * 0.72, cy + r * 0.35), (cx, cy + r),
                   (cx - r * 0.72, cy + r * 0.35)], outline=col, width=lw)
        d.arc([cx - r * 0.4, cy + r * 0.1, cx + r * 0.4, cy + r * 0.85], 20, 160,
              fill=col, width=lw)
    elif kind == "stall":
        d.arc([cx - r * 0.85, cy - r * 0.85, cx + r * 0.85, cy + r * 0.85], -60, 240,
              fill=col, width=lw)
        d.line([(cx, cy - r), (cx, cy + r * 0.15)], fill=col, width=lw)

def build_04():
    c = Image.new("RGB", (W, H), LGRAY)
    d = ImageDraw.Draw(c)
    fh = fit_font(d, T("КОГДА НУЖЕН РЕМКОМПЛЕКТ"), True, W - 90 * S, 40 * S)
    text_center(d, W // 2, 50 * S, T("КОГДА НУЖЕН РЕМКОМПЛЕКТ"), fh, INK)
    f_sub = fit_font(d, T("Изношенные прокладки, мембрана и клапан — частая причина неполадок"),
                     False, W - 90 * S, 23 * S)
    text_center(d, W // 2, 50 * S + fh.size + 16 * S,
                T("Изношенные прокладки, мембрана и клапан — частая причина неполадок"),
                f_sub, GRAY)
    cards = [
        ("idle", T("Плавающие обороты"), T("Мотор работает неровно на холостом ходу")),
        ("misfire", T("Перебои и провалы"), T("Рывки и провалы при наборе оборотов")),
        ("fuel", T("Подтекание топлива"), T("Запах бензина, мокрый карбюратор")),
        ("stall", T("Мотор глохнет"), T("Самопроизвольная остановка мотора")),
    ]
    y0, rh, gap = 186 * S, 152 * S, 18 * S
    for i, (kind, title, desc) in enumerate(cards):
        ry = y0 + i * (rh + gap)
        rounded(d, [50 * S, ry, 700 * S, ry + rh], 16 * S, fill=WHITE)
        icx, icy, ir = 132 * S, ry + rh // 2, 36 * S
        d.ellipse([icx - ir - 14 * S, icy - ir - 14 * S, icx + ir + 14 * S, icy + ir + 14 * S],
                  fill=TINT)
        icon(d, kind, icx, icy, ir, RED)
        f_t = fit_font(d, title, True, 480 * S, 27 * S)
        d.text((206 * S, ry + 34 * S), title, font=f_t, fill=INK)
        f_b = font(False, 21 * S)
        d.text((206 * S, ry + 34 * S + f_t.size + 14 * S), desc, font=f_b, fill=GRAY)
    # 底部深青结论带
    by = 892 * S
    rounded(d, [50 * S, by, 700 * S, 962 * S], 16 * S, fill=TEAL)
    f_f = fit_font(d, T("Замена изношенных деталей восстанавливает стабильную работу карбюратора"),
                   False, 620 * S, 21 * S)
    text_center(d, W // 2, by + (70 * S - f_f.size) / 2 - 2 * S,
                T("Замена изношенных деталей восстанавливает стабильную работу карбюратора"),
                f_f, WHITE)
    save_pair(c, "04-symptom")

# ---------------------------------------------------------------- 05-08 实拍
def photo_canvas():
    return Image.new("RGB", (1200, 1200), WHITE)

def build_photos():
    # 05 全家福 (img_03 竖排, 与 01 主图摆位不同)
    c = photo_canvas()
    fit_into(c, A("kit_vert.png"), (50, 50, 1150, 1150))
    save_photo(c, "05-photo-kit")
    # 06 垫片+膜片横带 (img_04)
    c = photo_canvas()
    fit_into(c, A("gasket_strip.png"), (90, 330, 1110, 870))
    save_photo(c, "06-photo-gasket")
    # 07 五金双拼 (img_04 针阀垫圈排 + img_01 螺丝弹垫排)
    c = photo_canvas()
    fit_into(c, A("hw_needle.png"), (60, 240, 585, 960))
    fit_into(c, A("screws.png"), (615, 240, 1140, 960))
    d = ImageDraw.Draw(c)
    d.line([(600, 220), (600, 980)], fill=(226, 230, 235), width=3)
    save_photo(c, "07-photo-hardware")
    # 08 浮子 + 大O环 双拼
    c = photo_canvas()
    fit_into(c, A("float.png"), (60, 240, 585, 960))
    fit_into(c, A("oring.png"), (615, 240, 1140, 960))
    d = ImageDraw.Draw(c)
    d.line([(600, 220), (600, 980)], fill=(226, 230, 235), width=3)
    save_photo(c, "08-photo-float-oring")

if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    prep_assets()
    build_01()
    build_02()
    build_03()
    build_04()
    build_photos()
    print("[done] gallery ->", OUT_DIR)
