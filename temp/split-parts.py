# -*- coding: utf-8 -*-
"""通用单件分割器（纯 numpy 版，无 scipy 依赖）：白底全家福 → 连通域分割出每个完整零件 → 白底 1200×1600 居中细节图
用法: python temp/split-parts.py <全家福图> <输出目录> [--min-area 0.01] [--pad 24]
要求: 单个产品完整不裁切、居中、占比合适（长边 55-75%）
"""
import sys, os
sys.stdout.reconfigure(encoding="utf-8")
import numpy as np
from PIL import Image

def _closing(mask, k=3):
    """binary closing（先 dilation 后 erosion，3x3）— 纯 numpy 实现"""
    p = k // 2
    pad = np.pad(mask, p, mode="constant", constant_values=False)
    win = np.lib.stride_tricks.sliding_window_view(pad, (k, k))
    dil = win.max(axis=(-2, -1))
    pad2 = np.pad(dil, p, mode="constant", constant_values=True)
    win2 = np.lib.stride_tricks.sliding_window_view(pad2, (k, k))
    return win2.min(axis=(-2, -1))

def _label(fg):
    """两遍扫描连通域标记（union-find）。返回 lab, n"""
    h, w = fg.shape
    lab = np.zeros((h, w), dtype=np.int32)
    parent = [0]
    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra
    nxt = 1
    for y in range(h):
        for x in range(w):
            if not fg[y, x]:
                continue
            ups = lab[y - 1, x] if y > 0 else 0
            lfs = lab[y, x - 1] if x > 0 else 0
            if ups == 0 and lfs == 0:
                lab[y, x] = nxt
                parent.append(nxt)
                nxt += 1
            elif ups == 0:
                lab[y, x] = lfs
            elif lfs == 0:
                lab[y, x] = ups
            else:
                lab[y, x] = min(ups, lfs)
                union(ups, lfs)
    for y in range(h):
        for x in range(w):
            if lab[y, x] > 0:
                lab[y, x] = find(lab[y, x])
    ids = sorted(set(lab[lab > 0].tolist()))
    remap = {v: i + 1 for i, v in enumerate(ids)}
    for y in range(h):
        for x in range(w):
            if lab[y, x] > 0:
                lab[y, x] = remap[lab[y, x]]
    return lab, len(ids)

def split_parts(src, outdir, min_area_ratio=0.008, pad=26, bg_thresh=235, max_scale=3.0):
    im = Image.open(src).convert("RGB")
    arr = np.array(im)
    h, w = arr.shape[:2]
    # 前景掩码：非近白像素
    fg = arr.min(axis=2) < bg_thresh
    fg = _closing(fg, 3)
    lab, n = _label(fg)
    print(f"[split] {os.path.basename(src)}: {n} 个连通域")
    parts = []
    for i in range(1, n + 1):
        ys, xs = np.where(lab == i)
        area = len(ys)
        if area < min_area_ratio * h * w:
            continue
        bw, bh = xs.max() - xs.min() + 1, ys.max() - ys.min() + 1
        if bw < 30 or bh < 30:
            continue
        parts.append((i, xs.min(), ys.min(), bw, bh, area))
    parts.sort(key=lambda p: -p[5])
    os.makedirs(outdir, exist_ok=True)
    W, H = 1200, 1600
    for rank, (i, x0, y0, bw, bh, area) in enumerate(parts, start=1):
        # 外扩留白（零件完整+呼吸感）
        xa, ya = max(0, x0 - pad), max(0, y0 - pad)
        xb, yb = min(w, x0 + bw + pad), min(h, y0 + bh + pad)
        crop = im.crop((xa, ya, xb, yb))
        # 二次清理：裁片内只保留最大连通域（主零件），相邻件残留涂白
        ca = np.array(crop)
        cmask = _closing(ca.min(axis=2) < bg_thresh, 3)
        clab, cn = _label(cmask)
        if cn > 1:
            sizes = [int((clab == j).sum()) for j in range(1, cn + 1)]
            keep = int(np.argmax(sizes)) + 1
            ca[clab != keep] = 255
            crop = Image.fromarray(ca)
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
        print(f"  part-{rank:02d}: 原({bw}x{bh}) 裁({crop.width}x{crop.height}) 缩放{r:.2f}x -> {out}")
    return [os.path.join(outdir, f"part-{r:02d}.jpg") for r in range(1, len(parts) + 1)]

if __name__ == "__main__":
    src = sys.argv[1]
    outdir = sys.argv[2]
    min_area = 0.008
    if "--min-area" in sys.argv:
        min_area = float(sys.argv[sys.argv.index("--min-area") + 1])
    split_parts(src, outdir, min_area)
    print("[done]")
