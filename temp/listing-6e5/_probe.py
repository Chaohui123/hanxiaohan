# -*- coding: utf-8 -*-
"""探针: 实测 6E5 素材水印带行范围 / 带内深色区 / 带内金属亮区 / 内容 bbox"""
import os
from PIL import Image

SRC = "temp/src-assets/carb-6e5/1688_966114840640/images"

def lum(p):
    return (p[0] * 299 + p[1] * 587 + p[2] * 114) // 1000

def analyze(name, top, bot):
    im = Image.open(os.path.join(SRC, name)).convert("RGB")
    w, h = im.size
    px = im.load()
    print(f"== {name} {w}x{h}  band-guess [{top},{bot}]")
    # 1) 灰浅像素行密度 -> 精确定位水印带
    hits = []
    for y in range(top - 60, bot + 60):
        cnt = 0
        for x in range(0, w, 2):
            p = px[x, y]
            l = lum(p)
            if 175 <= l <= 245 and (max(p) - min(p)) < 28:
                cnt += 1
        if cnt > 80:
            hits.append(y)
    if hits:
        print("  watermark rows:", min(hits), "-", max(hits))
    else:
        print("  watermark rows: none detected")
    # 2) 带内(+下延20) 列分类: dark(任一采样行 lum<120) / bright(>=60%采样行为金属亮)
    segs_d, segs_b = [], []
    in_d = in_b = False
    sd = sb = 0
    ys = list(range(top, bot + 20, 2))
    for x in range(w):
        dark = False
        br = 0
        for y in ys:
            p = px[x, y]
            l = lum(p)
            if l < 120:
                dark = True
            elif 120 <= l <= 235 and (max(p) - min(p)) < 45:
                br += 1
        bright = (not dark) and br >= len(ys) * 0.6
        if dark and not in_d:
            in_d, sd = True, x
        if in_d and (not dark or x == w - 1):
            segs_d.append((sd, x - 1)); in_d = False
        if bright and not in_b:
            in_b, sb = True, x
        if in_b and (not bright or x == w - 1):
            segs_b.append((sb, x - 1)); in_b = False
    print("  dark segs  :", [s for s in segs_d if s[1] - s[0] > 6])
    print("  bright segs:", [s for s in segs_b if s[1] - s[0] > 6])
    # 3) 内容 bbox (lum<240)
    minx, miny, maxx, maxy = w, h, 0, 0
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            if lum(px[x, y]) < 240:
                minx, maxx = min(minx, x), max(maxx, x)
                miny, maxy = min(miny, y), max(maxy, y)
    print("  content bbox:", (minx, miny, maxx, maxy))

analyze("img_01.webp", 385, 420)
analyze("img_02.webp", 380, 415)
analyze("img_03.webp", 380, 410)
analyze("img_04.webp", 385, 415)
analyze("img_05.webp", 385, 420)
