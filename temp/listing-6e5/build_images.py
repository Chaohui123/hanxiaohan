# -*- coding: utf-8 -*-
"""
ONZO · 6E5-W0093-06-00 化油器修理包 Ozon 图集生成器
4 张信息图 750x1000 (3:4, 61N/66T 骨架第三套差异化) + 4 张实拍副图 1200x1200
素材: temp/src-assets/carb-6e5/1688_966114840640/images/
  img_02.webp 叠放全家福(黑垫片+红垫片+铜件+针阀) -> 主图英雄 + 全家福裁片
  img_03.webp 五金(铜盖/O环/螺丝/针阀)           -> 五金裁片
  img_04.webp 红垫片特写                          -> 垫片卡
  img_05.webp 黑垫片特写                          -> 垫片卡
水印处理: "福鼎市双泰"中文横带统一在 y385-435（跨白底+红/黑垫片均质区）——
  逐列取带上/带下像素均值填充（白底区白填白、红/黑均质区近似无痕）。
与 61N(藏青+橙)/66T(深青+红) 差异化: 石墨+琥珀第三套配色。
红线: 零中文 / 零水印 / 零裁切(产品完整) / 不编规格数字 / 禁 Yamaha 品牌词(67F 教训)
卖点: V4/V6 双化油器机型 —— "ДЛЯ ДВУХ КАРБЮРАТОРОВ"（一次 2 套提示）
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

SRC = "temp/src-assets/carb-6e5/1688_966114840640/images"
ROOT_DIR = "temp/listing-6e5"
OUT_DIR = os.path.join(ROOT_DIR, "output")
ASSETS = os.path.join(ROOT_DIR, "_assets")
FB = "C:/Windows/Fonts/arialbd.ttf"
FR = "C:/Windows/Fonts/arial.ttf"
S = 2
W, H = 750 * S, 1000 * S

GRAPHITE = (51, 58, 66)
GRAPHITE_D = (36, 41, 47)
INK = (31, 41, 49)
GRAY = (106, 117, 128)
LGRAY = (240, 243, 245)
AMBER = (217, 148, 37)
AMBER_D = (180, 112, 22)
TINT = (253, 246, 234)
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
def whiten_band(im, name, y0=385, y1=435):
    """中文水印横带 y0-y1：均质列填上下缘均值，过渡列填带下缘色（垫片边缘不再出白色竖条）"""
    px = im.load()
    for x in range(im.width):
        top = px[x, y0 - 1]
        bot = px[x, y1 + 1]
        delta = sum(abs(top[i] - bot[i]) for i in range(3))
        fill = tuple((top[i] + bot[i]) // 2 for i in range(3)) if delta < 60 else bot
        for y in range(y0, y1 + 1):
            px[x, y] = fill
    print(f"[whiten_band] {name}: y{y0}-{y1} filled")
    return im

def prep_assets():
    os.makedirs(ASSETS, exist_ok=True)
    im02 = whiten_band(Image.open(os.path.join(SRC, "img_02.webp")).convert("RGB"), "img_02")
    im03 = whiten_band(Image.open(os.path.join(SRC, "img_03.webp")).convert("RGB"), "img_03")
    im04 = whiten_band(Image.open(os.path.join(SRC, "img_04.webp")).convert("RGB"), "img_04")
    im05 = whiten_band(Image.open(os.path.join(SRC, "img_05.webp")).convert("RGB"), "img_05")
    im01 = whiten_band(Image.open(os.path.join(SRC, "img_01.webp")).convert("RGB"), "img_01")

    # 主图全家福 (img_02 整图, 叠放全件 y100-770)
    im02.crop((40, 100, 780, 770)).save(os.path.join(ASSETS, "kit_full.png"))
    # 05 实拍全家福 (img_01 产品区, 去底部营销条+蓝边框 y<600)
    im01.crop((60, 40, 760, 600)).save(os.path.join(ASSETS, "kit_vert.png"))
    # 03 网格卡裁片（全部避开 y385-435 填充带）
    im05.crop((80, 180, 720, 370)).save(os.path.join(ASSETS, "gasket.png"))       # 黑垫片上半 (含双圆孔)
    im04.crop((90, 180, 720, 370)).save(os.path.join(ASSETS, "gasket_red.png"))  # 红垫片上半
    im03.crop((400, 440, 720, 700)).save(os.path.join(ASSETS, "needle.png"))     # 针阀+长杆 (右下, 带下)
    im03.crop((180, 140, 620, 370)).save(os.path.join(ASSETS, "jets.png"))       # 铜盖量孔 (上排, 带上)
    im03.crop((150, 280, 470, 370)).save(os.path.join(ASSETS, "orings.png"))     # O环组 (左中, 带上)
    # 02 照片卡: 黑垫片上半
    im05.crop((80, 180, 720, 370)).save(os.path.join(ASSETS, "gasket_card.png"))
    # 06 垫片横带 (红垫片上半)
    im04.crop((90, 180, 720, 370)).save(os.path.join(ASSETS, "gasket_strip.png"))
    # 07 五金 (铜盖上排 + 针阀右下)
    im03.crop((180, 140, 620, 370)).save(os.path.join(ASSETS, "hw_jets.png"))
    im03.crop((400, 440, 720, 700)).save(os.path.join(ASSETS, "hw_needle.png"))
    # 08 O环+红方垫 (左: img_03 O环带上; 右: img_02 红方垫带下)
    im02.crop((560, 440, 770, 600)).save(os.path.join(ASSETS, "redsquare.png"))
    print("[assets] prepared ->", ASSETS)

def A(name):
    return Image.open(os.path.join(ASSETS, name)).convert("RGB")

def fit_into(canvas, img, box, bg=WHITE, shadow=False):
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0, y1 - y0
    r = min(bw / img.width, bh / img.height)
    nw, nh = max(1, int(img.width * r)), max(1, int(img.height * r))
    im = img.resize((nw, nh), Image.LANCZOS)
    if shadow:
        sh = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        sd = ImageDraw.Draw(sh)
        sd.ellipse([x0 + bw * 0.12, y1 - 14 * S, x1 - bw * 0.12, y1 + 10 * S], fill=(0, 0, 0, 46))
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

# ---------------------------------------------------------------- 01 主图 (无带大标题 + 底部石墨色带 + 琥珀徽章)
def build_01():
    c = Image.new("RGB", (W, H), WHITE)
    d = ImageDraw.Draw(c)
    f_k = font(True, 24 * S)
    text_center(d, W // 2, 50 * S, T("АНАЛОГ 6E5-W0093-06-00 · 18-7002"), f_k, AMBER_D)
    f_t = fit_font(d, T("РЕМКОМПЛЕКТ"), True, W - 80 * S, 84 * S)
    text_center(d, W // 2, 96 * S, T("РЕМКОМПЛЕКТ"), f_t, INK)
    text_center(d, W // 2, 96 * S + f_t.size + 8 * S, T("КАРБЮРАТОРА"), f_t, INK)
    f_s = font(False, 27 * S)
    text_center(d, W // 2, 96 * S + f_t.size * 2 + 34 * S,
                T("для моторов V4 / V6 · 115-130 л.с."), f_s, GRAY)
    fit_into(c, A("kit_full.png"), (50 * S, 340 * S, 700 * S, 780 * S), shadow=True)
    d = ImageDraw.Draw(c)
    band_y = 810 * S
    c.paste(vgrad(W, H - band_y, GRAPHITE, GRAPHITE_D), (0, band_y))
    d = ImageDraw.Draw(c)
    f_m = fit_font(d, T("V4 / V6"), True, 330 * S, 58 * S)
    d.text((62 * S, 852 * S), T("V4 / V6"), font=f_m, fill=WHITE)
    f_sb = font(False, 25 * S)
    d.text((62 * S, 852 * S + f_m.size + 20 * S), T("115-130 л.с."),
           font=f_sb, fill=(200, 208, 214))
    # 右侧琥珀徽章胶囊（双化油器卖点）
    txt = T("ДЛЯ ДВУХ КАРБЮРАТОРОВ")
    f_b = fit_font(d, txt, True, 320 * S, 24 * S)
    tw = d.textlength(txt, font=f_b)
    pw, ph = tw + 56 * S, 66 * S
    cx, cy = 540 * S, 872 * S
    rounded(d, [cx - pw / 2, cy, cx + pw / 2, cy + ph], ph / 2, fill=AMBER)
    d.text((cx - tw / 2, cy + (ph - f_b.size) / 2 - 3 * S), txt, font=f_b, fill=WHITE)
    save_pair(c, "01-main")

# ---------------------------------------------------------------- 02 适配表 (通栏OE面板 + 三卡行)
def build_02():
    c = Image.new("RGB", (W, H), WHITE)
    d = ImageDraw.Draw(c)
    fh = font(True, 42 * S)
    d.text((50 * S, 52 * S), T("СОВМЕСТИМОСТЬ"), font=fh, fill=INK)
    d.rectangle([50 * S, 116 * S, 140 * S, 122 * S], fill=AMBER)
    rounded(d, [50 * S, 150 * S, 700 * S, 352 * S], 18 * S, fill=GRAPHITE)
    f_lab = font(False, 21 * S)
    d.text((80 * S, 172 * S), T("АНАЛОГ НОМЕРОВ OE"), font=f_lab, fill=(190, 198, 205))
    f_oe = fit_font(d, "6E5-W0093-06-00", True, 580 * S, 40 * S)
    d.text((80 * S, 204 * S), "6E5-W0093-06-00", font=f_oe, fill=WHITE)
    d.text((80 * S, 204 * S + f_oe.size + 10 * S), "18-7002", font=f_oe, fill=WHITE)
    f_sub = font(False, 21 * S)
    d.text((80 * S, 204 * S + f_oe.size * 2 + 32 * S),
           T("для двух карбюраторов мотора (V4 / V6)"), font=f_sub, fill=(190, 198, 205))
    cw, ch, gap = 206 * S, 258 * S, 16 * S
    y0 = 386 * S
    for i in range(3):
        x0 = 50 * S + i * (cw + gap)
        rounded(d, [x0, y0, x0 + cw, y0 + ch], 16 * S, fill=LGRAY)
    for i, (model, hp) in enumerate((("V4", "115 л.с."), ("V6", "130 л.с."))):
        x0 = 50 * S + i * (cw + gap)
        ccx, ccy, cr = x0 + cw // 2, y0 + 52 * S, 27 * S
        d.ellipse([ccx - cr, ccy - cr, ccx + cr, ccy + cr], fill=AMBER)
        d.line([(ccx - 12 * S, ccy + 1 * S), (ccx - 3 * S, ccy + 11 * S)], fill=WHITE, width=6 * S)
        d.line([(ccx - 3 * S, ccy + 11 * S), (ccx + 14 * S, ccy - 11 * S)], fill=WHITE, width=6 * S)
        f_m = fit_font(d, model, True, cw - 40 * S, 46 * S)
        text_center(d, x0 + cw // 2, y0 + 96 * S, model, f_m, GRAPHITE)
        f_p = font(False, 21 * S)
        text_center(d, x0 + cw // 2, y0 + 96 * S + f_m.size + 16 * S, T(hp), f_p, INK)
        text_center(d, x0 + cw // 2, y0 + 96 * S + f_m.size + 46 * S, T("2 карбюратора"), f_p, GRAY)
    x0 = 50 * S + 2 * (cw + gap)
    fit_into(c, A("gasket_card.png"), (x0 + 12 * S, y0 + 12 * S, x0 + cw - 12 * S, y0 + ch - 66 * S))
    d = ImageDraw.Draw(c)
    f_cap = font(False, 18 * S)
    for j, ln in enumerate(wrap(d, T("прокладка из комплекта"), f_cap, cw - 24 * S)[:2]):
        text_center(d, x0 + cw // 2, y0 + ch - 58 * S + j * 22 * S, ln, f_cap, GRAY)
    sy = 692 * S
    rounded(d, [50 * S, sy, 700 * S, 950 * S], 20 * S, fill=TINT)
    d.rectangle([50 * S, sy + 20 * S, 58 * S, 950 * S - 20 * S], fill=AMBER)
    f_h = font(True, 26 * S)
    d.text((84 * S, sy + 26 * S), T("КАК ПРОВЕРИТЬ ПЕРЕД ЗАКАЗОМ"), font=f_h, fill=AMBER_D)
    tips = [T("Сверьте номер на корпусе вашего карбюратора:"),
            T("6E5-W0093-06-00 или 18-7002 — комплект подходит."),
            T("В моторе V4/V6 два карбюратора — нужны 2 комплекта.")]
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
        ("gasket_red.png", T("Прокладки камеры")),
        ("jets.png", T("Жиклёры")),
        ("needle.png", T("Игольчатый клапан")),
        ("orings.png", T("Уплотн. кольца")),
        (None, None),
    ]
    gx, gy = 36 * S, 188 * S
    cw, ch, gap = 216 * S, 358 * S, 15 * S
    strip = 48 * S
    for i, (img, label) in enumerate(cards):
        col, row = i % 3, i // 3
        x0 = gx + col * (cw + gap)
        y0 = gy + row * (ch + gap)
        if img is None:  # 第 6 格: 石墨卖点文字卡
            rounded(d, [x0, y0, x0 + cw, y0 + ch], 16 * S, fill=GRAPHITE)
            f_t = font(True, 23 * S)
            cx = x0 + cw // 2
            text_center(d, cx, y0 + 92 * S, T("Все детали"), f_t, WHITE)
            text_center(d, cx, y0 + 92 * S + 34 * S, T("для переборки"), f_t, WHITE)
            text_center(d, cx, y0 + 92 * S + 68 * S, T("— в одном наборе"), f_t, WHITE)
            f_b = fit_font(d, T("не нужно подбирать детали"), False, cw - 24 * S, 19 * S)
            text_center(d, cx, y0 + 232 * S, T("не нужно подбирать детали"), f_b, (196, 203, 209))
            text_center(d, cx, y0 + 232 * S + 28 * S, T("по отдельности"), f_b, (196, 203, 209))
            continue
        rounded(d, [x0, y0, x0 + cw, y0 + ch], 16 * S, fill=WHITE)
        fit_into(c, A(img), (x0 + 12 * S, y0 + 12 * S, x0 + cw - 12 * S, y0 + ch - strip - 8 * S))
        d = ImageDraw.Draw(c)
        d.rectangle([x0, y0 + ch - strip, x0 + cw, y0 + ch], fill=GRAPHITE)
        d.rectangle([x0, y0 + ch - strip, x0 + cw, y0 + ch - strip + 6 * S], fill=GRAPHITE)
        f_l = fit_font(d, label, True, cw - 20 * S, 20 * S)
        text_center(d, x0 + cw // 2, y0 + ch - strip + (strip - f_l.size) / 2 - 3 * S,
                    label, f_l, WHITE)
    save_pair(c, "03-contents")

# ---------------------------------------------------------------- 04 症状提示 (浅底横向列表行)
def icon(d, kind, cx, cy, r, col):
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
        ("misfire", T("Провалы при разгоне"), T("Потеря мощности под нагрузкой")),
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
        icon(d, kind, icx, icy, ir, AMBER_D)
        f_t = fit_font(d, title, True, 480 * S, 27 * S)
        d.text((206 * S, ry + 34 * S), title, font=f_t, fill=INK)
        f_b = font(False, 21 * S)
        d.text((206 * S, ry + 34 * S + f_t.size + 14 * S), desc, font=f_b, fill=GRAY)
    by = 892 * S
    rounded(d, [50 * S, by, 700 * S, 962 * S], 16 * S, fill=GRAPHITE)
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
    c = photo_canvas()
    fit_into(c, A("kit_vert.png"), (50, 50, 1150, 1150))
    save_photo(c, "05-photo-kit")
    c = photo_canvas()
    fit_into(c, A("gasket_strip.png"), (90, 330, 1110, 870))
    save_photo(c, "06-photo-gasket")
    c = photo_canvas()
    fit_into(c, A("hw_jets.png"), (60, 240, 585, 960))
    fit_into(c, A("hw_needle.png"), (615, 240, 1140, 960))
    d = ImageDraw.Draw(c)
    d.line([(600, 220), (600, 980)], fill=(226, 230, 235), width=3)
    save_photo(c, "07-photo-hardware")
    c = photo_canvas()
    fit_into(c, A("orings.png"), (60, 240, 585, 960))
    fit_into(c, A("redsquare.png"), (615, 240, 1140, 960))
    d = ImageDraw.Draw(c)
    d.line([(600, 220), (600, 980)], fill=(226, 230, 235), width=3)
    save_photo(c, "08-photo-oring")

if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    prep_assets()
    build_01()
    build_02()
    build_03()
    build_04()
    build_photos()
    print("[done] gallery ->", OUT_DIR)
