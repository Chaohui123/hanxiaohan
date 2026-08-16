# -*- coding: utf-8 -*-
"""ONZO 俄文卖点轮播视频生成（6E7 桨毂衬套 / H6 门锁拉线）。

PIL 生成各帧：卖点封面(静态) + 图集 kenburns 帧 + 底部俄文字幕条；
ffmpeg xfade 交叉淡入串接 → 720x720 h264 yuv420p 30fps 无音轨 faststart。
帧文件保留在 temp/listing-*/frames/ 备查。
"""
import json
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.abspath(__file__))  # temp/
FPS = 30
BIG = 1080   # 幻灯片合成尺寸（kenburns 余量）
OUT = 720    # 输出边长
COVER_T = 1.5
SLIDE_T = 3.5
XFADE = 0.5

NAVY = (13, 45, 78)
ORANGE = (255, 122, 26)
LBLUE = (130, 200, 235)
WHITE = (255, 255, 255)

FONT_PATH = "C:/Windows/Fonts/arialbd.ttf"


def F(size):
    return ImageFont.truetype(FONT_PATH, size)


def fit_text(d, text, size, maxw):
    """从 size 起递减直到文本宽度 <= maxw"""
    size = round(size)
    while size > 12:
        f = F(size)
        if d.textlength(text, font=f) <= maxw:
            return f
        size -= 2
    return F(12)


def cover_fit(img, size):
    """等比缩放铺满 size×size 并居中裁剪"""
    w, h = img.size
    s = max(size / w, size / h)
    img2 = img.resize((round(w * s), round(h * s)), Image.LANCZOS)
    x = (img2.width - size) // 2
    y = (img2.height - size) // 2
    return img2.crop((x, y, x + size, y + size))


def trim_white(img, thresh=242, margin=26):
    """按近白背景自动裁出主体 bbox"""
    g = img.convert("L")
    bbox = g.point(lambda p: 255 if p < thresh else 0).getbbox()
    if not bbox:
        return img
    l, t, r, b = bbox
    return img.crop((max(0, l - margin), max(0, t - margin),
                     min(img.width, r + margin), min(img.height, b + margin)))


def compose_slide(path, patch=None):
    """单图 → BIG×BIG 幻灯片。竖版卡片：模糊底+等高居中；方图：cover-fit。
    patch: (x0,y0,x1,y1) 用背景色覆盖的区域（如供应商角标）。"""
    img = Image.open(path).convert("RGB")
    if patch:
        d = ImageDraw.Draw(img)
        bg = img.getpixel((img.width - 12, 12))
        d.rectangle(patch, fill=bg)
    w, h = img.size
    if h > w * 1.12:
        bg = cover_fit(img, BIG).filter(ImageFilter.GaussianBlur(42))
        bg = ImageEnhance.Brightness(bg).enhance(0.82)
        fg = img.resize((round(w * BIG / h), BIG), Image.LANCZOS)
        bg.paste(fg, ((BIG - fg.width) // 2, 0))
        return bg
    return cover_fit(img, BIG)


def make_cover(product_img, title, subtitle, oe_text, badge, out_path):
    """67F 版式卖点封面：藏青标题条 + 白底产品图 + OE 胶囊 + 橙色角标。
    在 BIG 尺寸绘制后降采样到 720（文字更锐利）。"""
    S = BIG / 720.0
    cv = Image.new("RGB", (BIG, BIG), WHITE)
    d = ImageDraw.Draw(cv)

    band_h = round(128 * S)
    d.rectangle([0, 0, BIG, band_h], fill=NAVY)
    d.text((BIG // 2, round(46 * S)), title, font=fit_text(d, title, 40 * S, BIG - round(70 * S)),
           fill=WHITE, anchor="mm")
    d.text((BIG // 2, round(96 * S)), subtitle, font=fit_text(d, subtitle, 27 * S, BIG - round(60 * S)),
           fill=LBLUE, anchor="mm")

    area_top, area_bot = band_h, round(610 * S)
    p = product_img
    s = min(round(648 * S) / p.width, (area_bot - area_top - round(36 * S)) / p.height)
    p2 = p.resize((max(1, round(p.width * s)), max(1, round(p.height * s))), Image.LANCZOS)
    cv.paste(p2, ((BIG - p2.width) // 2, area_top + (area_bot - area_top - p2.height) // 2))

    f_oe = F(round(29 * S))
    tb = d.textbbox((0, 0), oe_text, font=f_oe)
    pw = (tb[2] - tb[0]) + round(64 * S)
    y0, y1 = round(626 * S), round(686 * S)
    d.rounded_rectangle([(BIG - pw) // 2, y0, (BIG + pw) // 2, y1], radius=(y1 - y0) // 2, fill=NAVY)
    d.text((BIG // 2, (y0 + y1) // 2), oe_text, font=f_oe, fill=WHITE, anchor="mm")

    f_b = F(round(22 * S))
    bb = d.textbbox((0, 0), badge, font=f_b)
    bw = (bb[2] - bb[0]) + round(40 * S)
    bh = round(44 * S)
    x1 = BIG - round(26 * S)
    d.rounded_rectangle([x1 - bw, band_h + round(18 * S), x1, band_h + round(18 * S) + bh],
                        radius=bh // 2, fill=ORANGE)
    d.text((x1 - bw // 2, band_h + round(18 * S) + bh // 2), badge, font=f_b, fill=WHITE, anchor="mm")

    cv.resize((OUT, OUT), Image.LANCZOS).save(out_path, "JPEG", quality=95)
    return cv  # BIG 尺寸，供帧生成


def wrap_text(d, text, font, maxw):
    words = text.split()
    lines, cur = [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if d.textlength(t, font=font) <= maxw:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def draw_subs(frame, text):
    """底部俄文卖点字幕条：藏青半透明带 + 橙色顶线 + 白字（最多两行）"""
    band_h = 108
    ov = Image.new("RGBA", (OUT, OUT), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    d.rectangle([0, OUT - band_h, OUT, OUT], fill=NAVY + (216,))
    d.rectangle([0, OUT - band_h, OUT, OUT - band_h + 4], fill=ORANGE + (255,))
    size = 30
    while size >= 22:
        f = F(size)
        lines = wrap_text(d, text, f, OUT - 96)
        if len(lines) <= 2:
            break
        size -= 2
    lh = round(size * 1.24)
    total = lh * len(lines)
    y = OUT - band_h + (band_h - total) // 2 + lh // 2
    for ln in lines:
        d.text((OUT // 2, y), ln, font=f, fill=WHITE + (255,), anchor="mm")
        y += lh
    return Image.alpha_composite(frame.convert("RGBA"), ov).convert("RGB")


def kenburns(slide_big, n, z0, z1, dx, dy):
    """缩放缓推帧序列：z 从 z0→z1，中心漂移 (dx,dy)（BIG 坐标系）"""
    frames = []
    for i in range(n):
        t = i / (n - 1) if n > 1 else 0.0
        z = z0 + (z1 - z0) * t
        win = BIG / z
        cx = BIG / 2 + dx * (t - 0.5)
        cy = BIG / 2 + dy * (t - 0.5)
        x0 = min(max(cx - win / 2, 0), BIG - win)
        y0 = min(max(cy - win / 2, 0), BIG - win)
        fr = slide_big.crop((round(x0), round(y0), round(x0 + win), round(y0 + win)))
        frames.append(fr.resize((OUT, OUT), Image.LANCZOS))
    return frames


def build_video(cfg):
    listing = cfg["dir"]
    fdir = os.path.join(listing, "frames")
    os.makedirs(fdir, exist_ok=True)
    cover_t = cfg.get("cover_t", COVER_T)
    slide_t = cfg.get("slide_t", SLIDE_T)
    xfade = cfg.get("xfade", XFADE)

    seg_dirs = []

    # seg0：卖点封面（静态 1.5s）
    cover_big = make_cover(out_path=os.path.join(fdir, "cover.jpg"), **cfg["cover"])
    sd = os.path.join(fdir, "seg0")
    os.makedirs(sd, exist_ok=True)
    f720 = cover_big.resize((OUT, OUT), Image.LANCZOS)
    for i in range(round(cover_t * FPS)):
        f720.save(os.path.join(sd, f"{i:04d}.jpg"), quality=95)
    seg_dirs.append(sd)

    # seg1..N：图集 kenburns + 字幕条
    for k, sl in enumerate(cfg["slides"], start=1):
        img, sub, (z0, z1, dx, dy), patch = sl
        slide = compose_slide(os.path.join(listing, img), patch=patch)
        slide.save(os.path.join(fdir, f"slide{k}.jpg"), quality=92)
        sd = os.path.join(fdir, f"seg{k}")
        os.makedirs(sd, exist_ok=True)
        n = round(slide_t * FPS)
        for i, fr in enumerate(kenburns(slide, n, z0, z1, dx, dy)):
            draw_subs(fr, sub).save(os.path.join(sd, f"{i:04d}.jpg"), quality=95)
        seg_dirs.append(sd)

    # ffmpeg xfade 交叉淡入串接
    inputs = []
    for sd in seg_dirs:
        inputs += ["-framerate", str(FPS), "-i", os.path.join(sd, "%04d.jpg")]
    fc = []
    for k in range(len(seg_dirs)):
        fc.append(f"[{k}]scale={OUT}:{OUT}:flags=lanczos:in_range=full:out_range=limited,"
                  f"format=yuv420p,setsar=1[f{k}]")
    off = cover_t - xfade
    cur = "f0"
    for k in range(1, len(seg_dirs)):
        lbl = f"x{k}"
        fc.append(f"[{cur}][f{k}]xfade=transition=fade:duration={xfade}:offset={off:.3f}[{lbl}]")
        cur = lbl
        off += slide_t - xfade
    expected = cover_t + slide_t * len(cfg["slides"]) - xfade * len(cfg["slides"])

    cmd = (["ffmpeg", "-y", "-v", "error"] + inputs +
           ["-filter_complex", ";".join(fc), "-map", f"[{cur}]",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "medium",
            "-r", str(FPS), "-an", "-movflags", "+faststart", cfg["out"]])
    subprocess.run(cmd, check=True)

    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "stream=codec_name,codec_type,width,height,pix_fmt,r_frame_rate:format=duration",
         "-of", "json", cfg["out"]],
        capture_output=True, text=True, check=True).stdout
    info = json.loads(probe)
    streams = info.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), {})
    return {
        "out": cfg["out"],
        "expected_duration": round(expected, 2),
        "duration": float(info["format"]["duration"]),
        "video": {k: v.get(k) for k in ("codec_name", "width", "height", "pix_fmt", "r_frame_rate")},
        "audio_streams": [s for s in streams if s.get("codec_type") == "audio"],
    }


def main():
    hub_product = trim_white(Image.open(os.path.join(ROOT, "listing-hub6E7/06-photo-3.jpg")).convert("RGB"))
    door_src = Image.open(os.path.join(ROOT, "listing-door-cable/01-main.jpg")).convert("RGB")
    door_product = trim_white(door_src.crop((0, 300, 750, 680)), thresh=235, margin=20)
    # 艇罩封面产品图：抠图 RGBA 压白底后按近白裁边
    cut = Image.open(os.path.join(ROOT, "listing-boat-cover/src_png/cutout_motor.png")).convert("RGBA")
    flat = Image.new("RGB", cut.size, (255, 255, 255))
    flat.paste(cut, (0, 0), cut.split()[3])
    boat_product = trim_white(flat, thresh=245, margin=16)
    # 化油器包封面产品图：全家福零件底图
    carb_product = trim_white(Image.open(os.path.join(ROOT, "listing-carb-kit/_assets/kit_full.png")).convert("RGB"), thresh=245, margin=16)
    # 发电机双燃料化油器封面产品图
    gen_product = trim_white(Image.open(os.path.join(ROOT, "listing-gen-carb/_assets/carb_side.png")).convert("RGB"), thresh=245, margin=16)
    # 66T 修理包封面产品图（全家福）
    carb66t_product = trim_white(Image.open(os.path.join(ROOT, "listing-66t/_assets/kit_full.png")).convert("RGB"), thresh=245, margin=16)

    configs = [
        {
            "dir": os.path.join(ROOT, "listing-hub6E7"),
            "out": os.path.join(ROOT, "listing-hub6E7/video-6E7-final.mp4"),
            "cover": dict(product_img=hub_product,
                          title="ВТУЛКА ГРЕБНОГО ВИНТА",
                          subtitle="YAMAHA 9.9-20 л.с. 2Т",
                          oe_text="АНАЛОГ 6E7-45987-01·00",
                          badge="ДЕМПФЕР"),
            "slides": [
                ("01-main.jpg", "Аналог штатных номеров 6E7-45987-01 и 6E7-45987-00",
                 (1.02, 1.10, 18, -8), None),
                ("02-fitment.jpg", "Подходит к моторам Yamaha 9.9, 15 и 20 л.с. (2Т)",
                 (1.10, 1.02, -18, 8), None),
                ("03-detail.jpg", "Демпфер гасит удар и защищает шлицы и редуктор мотора",
                 (1.02, 1.10, 14, 10), None),
                ("04-photo-1.jpg", "Винт проворачивается, лодка теряет ход — втулку пора менять",
                 (1.06, 1.20, -20, -12), (0, 0, 175, 180)),
                ("06-photo-3.jpg", "Запрессовывается в ступицу — замена в мастерской с прессом",
                 (1.20, 1.06, 20, 10), None),
            ],
        },
        {
            "dir": os.path.join(ROOT, "listing-door-cable"),
            "out": os.path.join(ROOT, "listing-door-cable/video-door-final.mp4"),
            "cover": dict(product_img=door_product,
                          title="ТРОС ЗАМКА ДВЕРИ",
                          subtitle="HAVAL H6",
                          oe_text="АНАЛОГ 6105109XKZ16A",
                          badge="ПЕРЕДНЯЯ ДВЕРЬ"),
            "slides": [
                ("01-main.jpg", "Передняя дверь — трос от замка к наружной ручке",
                 (1.02, 1.10, 18, -8), None),
                ("02-fitment.jpg", "Аналог OE 6105109XKZ16A — установка без доработок",
                 (1.10, 1.02, -18, 8), None),
                ("03-install.jpg", "Замена со снятием обшивки — без опыта лучше в сервисе",
                 (1.02, 1.10, 16, 10), None),
                ("04-check.jpg", "Сверьте номер и измерьте длину старого троса",
                 (1.10, 1.02, -16, -8), None),
                ("05-photo-full.jpg", "Восстанавливает открытие двери снаружи",
                 (1.06, 1.20, 22, -14), None),
            ],
        },
        {
            "dir": os.path.join(ROOT, "listing-boat-cover"),
            "out": os.path.join(ROOT, "listing-boat-cover/video-cover-final.mp4"),
            "cover": dict(product_img=boat_product,
                          title="ЧЕХОЛ ДЛЯ ЛОДОЧНОГО МОТОРА",
                          subtitle="ОКСФОРД 210D",
                          oe_text="S / M · до 30 л.с.",
                          badge="ВОДОНЕПРОНИЦАЕМЫЙ"),
            "slides": [
                ("01-main.jpg", "Чехол для лодочного мотора 5-30 л.с., оксфорд 210D",
                 (1.02, 1.10, 18, -8), None),
                ("02-fitment.jpg", "Два размера: S до 15 л.с. и M 15-30 л.с.",
                 (1.10, 1.02, -18, 8), None),
                ("03-material.jpg", "Водонепроницаемый оксфорд — защита от влаги и УФ",
                 (1.02, 1.10, 14, 10), None),
                ("04-season.jpg", "Сезонное хранение: от пыли, снега и выцветания",
                 (1.06, 1.20, -20, -12), None),
                ("05-colors.jpg", "Плотная резинка — надежная посадка без завязок",
                 (1.20, 1.06, 20, 10), None),
            ],
        },
        {
            "dir": os.path.join(ROOT, "listing-carb-kit"),
            "out": os.path.join(ROOT, "listing-carb-kit/video-61n-final.mp4"),
            "cover": dict(product_img=carb_product,
                          title="РЕМКОМПЛЕКТ КАРБЮРАТОРА",
                          subtitle="YAMAHA 25-30 л.с. · T30 · 2Т",
                          oe_text="АНАЛОГ 61N-W0093-00",
                          badge="ПОЛНЫЙ НАБОР"),
            "slides": [
                ("01-main.jpg", "Ремкомплект карбюратора Yamaha 25-30 л.с. (T30, 2Т)",
                 (1.02, 1.10, 18, -8), None),
                ("02-fitment.jpg", "Аналог штатного 61N-W0093-00 — установка без доработок",
                 (1.10, 1.02, -18, 8), None),
                ("03-contents.jpg", "Все детали для переборки — в одном комплекте",
                 (1.02, 1.10, 14, 10), None),
                ("04-symptom.jpg", "Перебои, глохнет, растёт расход — время перебрать карбюратор",
                 (1.06, 1.20, -20, -12), None),
                ("05-photo-kit.jpg", "Поплавок, клапан, прокладки, мембрана, винты и пружины",
                 (1.20, 1.06, 20, 10), None),
            ],
        },
        {
            "dir": os.path.join(ROOT, "listing-gen-carb"),
            "out": os.path.join(ROOT, "listing-gen-carb/video-gen-final.mp4"),
            "cover": dict(product_img=gen_product,
                          title="КАРБЮРАТОР ГАЗ-БЕНЗИН",
                          subtitle="для генераторов 2-3 кВт",
                          oe_text="168F / 170F · GX160 / GX200",
                          badge="ДВОЙНОЕ ТОПЛИВО"),
            "slides": [
                ("01-main.jpg", "Карбюратор газ-бензин для генератора 2-3 кВт",
                 (1.02, 1.10, 18, -8), None),
                ("02-fitment.jpg", "Двигатели 168F, 170F, GX160, GX200",
                 (1.10, 1.02, -18, 8), None),
                ("03-benefit.jpg", "Экономия на топливе до 40%",
                 (1.02, 1.10, 14, 10), None),
                ("04-scene.jpg", "Аварийное питание: дача, дом, отключение света",
                 (1.06, 1.20, -20, -12), None),
                ("05-photo-top.jpg", "Прямая замена штатного — установка без доработок",
                 (1.20, 1.06, 20, 10), None),
            ],
        },
        {
            "dir": os.path.join(ROOT, "listing-66t/output"),
            "out": os.path.join(ROOT, "listing-66t/output/video-66t-final.mp4"),
            # 故事线（与主图"全套件+适配"差异化）：症状痛点→原因→解决→核对件号→效果
            "cover": dict(product_img=carb66t_product,
                          title="МОТОР ГЛОХНЕТ?",
                          subtitle="Перебои на холостом ходу",
                          oe_text="РЕМКОМПЛЕКТ 66T-W0093-00/01",
                          badge="РЕШЕНИЕ ЗДЕСЬ"),
            "slides": [
                ("04-symptom.jpg", "Знакомо? Глохнет, перебои, трудный запуск, течёт топливо",
                 (1.02, 1.12, 16, -8), None),
                ("03-contents.jpg", "Причина — износ прокладок и игольчатого клапана",
                 (1.10, 1.02, -16, 8), None),
                ("05-photo-kit.jpg", "Ремкомплект 66T-W0093-00 — полный набор для переборки",
                 (1.02, 1.12, 14, 10), None),
                ("02-fitment.jpg", "Подходит к карбюраторам 66T-14301-00/01/02 — сверьте номер",
                 (1.10, 1.02, -18, 8), None),
                ("01-main.jpg", "Мотор снова работает ровно — закажите сейчас",
                 (1.06, 1.18, -18, -10), None),
            ],
        },
    ]

    # 禁用词自检
    banned = ["оригинал"]
    for cfg in configs:
        texts = [sl[1] for sl in cfg["slides"]] + [cfg["cover"]["title"],
                cfg["cover"]["subtitle"], cfg["cover"]["oe_text"], cfg["cover"]["badge"]]
        for t in texts:
            for b in banned:
                assert b not in t.lower(), f"禁用词命中: {b} in {t}"

    # 可选过滤：python temp/make-carousel-videos.py hub|door
    only = sys.argv[1] if len(sys.argv) > 1 else None
    if only:
        configs = [c for c in configs if only in c["dir"]]
        assert configs, f"无匹配配置: {only}"

    results = [build_video(cfg) for cfg in configs]
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    sys.exit(main())
