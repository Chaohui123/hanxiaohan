# -*- coding: utf-8 -*-
"""通用单件分割器：白底全家福 → 连通域分割出每个完整零件 → 白底 1200×1600 居中细节图
用法: python temp/split-parts.py <全家福图> <输出目录> [--min-area 0.01] [--pad 24]
要求: 单个产品完整不裁切、居中、占比合适（长边 55-75%）
"""
import sys, os
sys.stdout.reconfigure(encoding="utf-8")
import numpy as np
from PIL import Image
from scipy import ndimage

def split_parts(src, outdir, min_area_ratio=0.008, pad=26, bg_thresh=235, max_scale=3.0):
    im = Image.open(src).convert("RGB")
    arr = np.array(im)
    h, w = arr.shape[:2]
    # 前景掩码：非近白像素
    fg = (arr.min(axis=2) < bg_thresh)
    # 轻微闭运算连小缝（3x3 防密集零件连通）
    fg = ndimage.binary_closing(fg, structure=np.ones((3, 3)))
    lab, n = ndimage.label(fg)
    print(f"[split] {os.path.basename(src)}: {n} 个连通域")
    objs = ndimage.find_objects(lab)
    parts = []
    for i, sl in enumerate(objs, start=1):
        ys, xs = sl
        area = int((lab[sl] == i).sum())
        bw, bh = xs.stop - xs.start, ys.stop - ys.start
        if area < min_area_ratio * h * w:  # 过滤噪点
            continue
        if bw < 30 or bh < 30:
            continue
        parts.append((i, xs.start, ys.start, bw, bh, area))
    parts.sort(key=lambda p: -p[5])  # 按面积降序
    os.makedirs(outdir, exist_ok=True)
    W, H = 1200, 1600
    made = []
    for rank, (i, x0, y0, bw, bh, area) in enumerate(parts, start=1):
        # 外扩留白（零件完整+呼吸感）
        xa, ya = max(0, x0 - pad), max(0, y0 - pad)
        xb, yb = min(w, x0 + bw + pad), min(h, y0 + bh + pad)
        crop = im.crop((xa, ya, xb, yb))
        # 二次清理：裁片内只保留最大连通域（主零件），相邻件残留涂白
        ca = np.array(crop)
        cmask = (ca.min(axis=2) < bg_thresh)
        cmask = ndimage.binary_closing(cmask, structure=np.ones((3, 3)))
        clab, cn = ndimage.label(cmask)
        if cn > 1:
            sizes = ndimage.sum(cmask, clab, range(1, cn + 1))
            keep = int(np.argmax(sizes)) + 1
            ca[clab != keep] = 255
            crop = Image.fromarray(ca)
            # 按主零件重新裁剪（去掉涂白空边）
            ys2, xs2 = np.where(clab == keep)
            crop = crop.crop((xs2.min(), ys2.min(), xs2.max() + 1, ys2.max() + 1))
        # 白底画布，居中，占比合适（长边 60% 左右）
        target_ratio = 0.70
        r = min((W * target_ratio) / crop.width, (H * 0.72) / crop.height, max_scale)
        nw, nh = int(crop.width * r), int(crop.height * r)
        c = Image.new("RGB", (W, H), (255, 255, 255))
        sim = crop.resize((nw, nh), Image.LANCZOS)
        c.paste(sim, ((W - nw) // 2, (H - nh) // 2))
        out = os.path.join(outdir, f"part-{rank:02d}.jpg")
        c.save(out, quality=92)
        made.append(out)
        print(f"  part-{rank:02d}: 原({bw}x{bh}) 裁({crop.width}x{crop.height}) 缩放{r:.2f}x → {out}")
    return made

if __name__ == "__main__":
    src = sys.argv[1]
    outdir = sys.argv[2]
    min_area = 0.008
    if "--min-area" in sys.argv:
        min_area = float(sys.argv[sys.argv.index("--min-area") + 1])
    split_parts(src, outdir, min_area)
    print("[done]")
