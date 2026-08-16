# -*- coding: utf-8 -*-
"""ONZO · 6E5-W0093-06-00 化油器修理包 · 轮播视频 config
故事线（机型驱动，与 66T 症状驱动差异化）：
  V4/V6 双化油器机型 → 一次需 2 套 → 套件内容 → 核对件号 → 效果
并入方法（两步）:
1) temp/make-carousel-videos.py 的 main() 产品图预处理区追加:
       carb6e5_product = trim_white(Image.open(os.path.join(
           ROOT, "listing-6e5/_assets/kit_full.png")).convert("RGB"), thresh=245, margin=16)
2) configs 列表追加下面 CONFIG_6E5（product_img 换成 carb6e5_product 变量）。
   单独出片: python temp/make-carousel-videos.py 6e5
红线自检: 文案不含 "оригинал"/"yamaha"。
"""
import os

ROOT = "temp"

CONFIG_6E5 = {
    "dir": os.path.join(ROOT, "listing-6e5/output"),
    "out": os.path.join(ROOT, "listing-6e5/output/video-6e5-final.mp4"),
    "cover": dict(product_img="carb6e5_product",
                  title="ДВА КАРБЮРАТОРА?",
                  subtitle="Моторы V4 / V6 · 115-130 л.с.",
                  oe_text="РЕМКОМПЛЕКТ 6E5-W0093-06-00",
                  badge="НУЖНЫ 2 НАБОРА"),
    "slides": [
        ("01-main.jpg", "На моторах V4 / V6 — два карбюратора, для переборки нужны 2 набора",
         (1.02, 1.12, 16, -8), None),
        ("03-contents.jpg", "Прокладки, мембрана, поплавок, клапан — всё в одном наборе",
         (1.10, 1.02, -16, 8), None),
        ("05-photo-kit.jpg", "Одного набора хватает на один карбюратор",
         (1.02, 1.12, 14, 10), None),
        ("02-fitment.jpg", "Совместим с 6E5-W0093-06-00 и 18-7002 — сверьте номер",
         (1.10, 1.02, -18, 8), None),
        ("04-symptom.jpg", "Провалы, глохнет, потеря мощности — время перебрать",
         (1.06, 1.18, -18, -10), None),
    ],
}

if __name__ == "__main__":
    banned = ["оригинал", "yamaha"]
    texts = [s[1] for s in CONFIG_6E5["slides"]] + [
        CONFIG_6E5["cover"]["title"], CONFIG_6E5["cover"]["subtitle"],
        CONFIG_6E5["cover"]["oe_text"], CONFIG_6E5["cover"]["badge"]]
    for t in texts:
        for b in banned:
            assert b not in t.lower(), f"禁用词命中: {b} in {t}"
    print("config self-check OK")
