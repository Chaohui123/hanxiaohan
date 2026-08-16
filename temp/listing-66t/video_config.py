# -*- coding: utf-8 -*-
"""
ONZO · 66T-W0093-00/01 化油器修理包 · 轮播视频 config
结构对齐 temp/make-carousel-videos.py 的 61N config, 先不跑生成。

并入方法（两步）:
1) temp/make-carousel-videos.py 的 main() 产品图预处理区追加:
       carb66t_product = trim_white(Image.open(os.path.join(
           ROOT, "listing-66t/_assets/kit_full.png")).convert("RGB"), thresh=245, margin=16)
2) configs 列表追加下面 CONFIG_66T（product_img 换成 carb66t_product 变量）。
   单独出片: python temp/make-carousel-videos.py carb-66t

红线自检: 文案不含 "оригинал"（脚本内已有断言），且全程无 Yamaha 品牌词（67F 教训）。
"""
import os

ROOT = "temp"

CONFIG_66T = {
    "dir": os.path.join(ROOT, "listing-66t/output"),
    "out": os.path.join(ROOT, "listing-66t/output/video-66t-final.mp4"),
    "cover": dict(product_img="carb66t_product",  # 并入时替换为上面的 PIL 变量
                  title="РЕМКОМПЛЕКТ КАРБЮРАТОРА",
                  subtitle="40 л.с. · 40X/E40X · 2Т",
                  oe_text="АНАЛОГ 66T-W0093-00/01",
                  badge="ПОЛНЫЙ НАБОР"),
    "slides": [
        ("01-main.jpg", "Ремкомплект карбюратора для моторов 40 л.с. (40X/E40X, 2Т)",
         (1.02, 1.10, 18, -8), None),
        ("02-fitment.jpg", "Аналог штатного 66T-W0093-00/01 — установка без доработок",
         (1.10, 1.02, -18, 8), None),
        ("03-contents.jpg", "Прокладки, мембрана, поплавок, клапан — всё в одном наборе",
         (1.02, 1.10, 14, 10), None),
        ("04-symptom.jpg", "Перебои, глохнет, течёт карбюратор — время перебрать",
         (1.06, 1.20, -20, -12), None),
        ("05-photo-kit.jpg", "Поплавок, клапан, прокладки, мембрана, винты и шайбы",
         (1.20, 1.06, 20, 10), None),
    ],
}

if __name__ == "__main__":
    # 本地自检: 禁用词 + 素材文件齐备
    banned = ["оригинал", "yamaha"]
    texts = [s[1] for s in CONFIG_66T["slides"]] + [
        CONFIG_66T["cover"]["title"], CONFIG_66T["cover"]["subtitle"],
        CONFIG_66T["cover"]["oe_text"], CONFIG_66T["cover"]["badge"]]
    for t in texts:
        for b in banned:
            assert b not in t.lower(), f"禁用词命中: {b} in {t}"
    for name, *_ in CONFIG_66T["slides"]:
        p = os.path.join(CONFIG_66T["dir"], name)
        assert os.path.exists(p), f"缺 slide 素材: {p}"
    kit = os.path.join(ROOT, "listing-66t/_assets/kit_full.png")
    assert os.path.exists(kit), f"缺封面产品图: {kit}"
    print("[ok] 66T video config 自检通过 (文案纯净, 5 帧素材齐备)")
