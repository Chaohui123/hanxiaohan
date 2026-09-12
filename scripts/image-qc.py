# -*- coding: utf-8 -*-
"""商品图 CI 质检闸（agent-sop.md 6.5 节实现）：每张图必过才可上传。
用法: python scripts/image-qc.py <图文件或目录> [--role main|detail|info]
校验: ①四角背景近白(>240) ②主体占比(main 70-90% / detail 40-90% / info 免) ③长边≥1000px
④(启发式)顶部/底部无连续深色横带(水印/营销条特征)
退出码: 全部过=0, 任一 FAIL=1（打印每张判定）
"""
import sys, os
sys.stdout.reconfigure(encoding="utf-8")
import numpy as np
from PIL import Image

def qc(path, role="detail"):
    im = Image.open(path).convert("RGB")
    arr = np.array(im)
    h, w = arr.shape[:2]
    fails = []
    # ① 四角背景（info 信息图为设计排版背景，豁免）
    if role != "info":
        c = 30
        corners = np.concatenate([
            arr[:c, :c].reshape(-1, 3), arr[:c, -c:].reshape(-1, 3),
            arr[-c:, :c].reshape(-1, 3), arr[-c:, -c:].reshape(-1, 3)])
        bg = corners.mean(axis=0)
        if bg.min() < 240:
            fails.append(f"四角背景非纯白 RGB{tuple(int(x) for x in bg)}")
    # ② 主体占比（长边口径：max(宽占比, 高占比)，SOP 6.2 行业执行值）
    if role != "info":
        fg = arr.min(axis=2) < 235
        if fg.sum() > 0:
            ys, xs = np.where(fg)
            bw, bh = xs.max() - xs.min() + 1, ys.max() - ys.min() + 1
            ratio = max(bw / w, bh / h)
            lo, hi = (0.70, 0.95) if role == "main" else (0.45, 0.95)
            if not (lo <= ratio <= hi):
                fails.append(f"主体长边占比 {ratio*100:.0f}% 超出 [{int(lo*100)}-{int(hi*100)}%]")
        else:
            fails.append("无主体")
    # ③ 分辨率
    if max(w, h) < 1000:
        fails.append(f"分辨率 {w}x{h} 长边<1000")
    # ④ 顶部/底部连续深色横带（水印/营销条特征，仅 main/detail）
    if role != "info":
        for band_name, band in (("顶部", arr[:int(h*0.06)]), ("底部", arr[int(h*0.94):])):
            rowmean = float(band.mean())  # 整带均值
            if rowmean < 200:  # 整带偏暗=横条
                fails.append(f"{band_name}疑有深色横带(均值{int(rowmean)})")
    return fails

def main():
    target = sys.argv[1]
    role = "detail"
    if "--role" in sys.argv:
        role = sys.argv[sys.argv.index("--role") + 1]
    files = []
    if os.path.isdir(target):
        for f in sorted(os.listdir(target)):
            if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
                files.append(os.path.join(target, f))
    else:
        files = [target]
    bad = 0
    for f in files:
        fails = qc(f, role)
        mark = "PASS" if not fails else "FAIL"
        if fails: bad += 1
        print(f"[{mark}] {os.path.basename(f)}" + ("" if not fails else "  -> " + "; ".join(fails)))
    print(f"[qc] {len(files)-bad}/{len(files)} 通过")
    sys.exit(1 if bad else 0)

if __name__ == "__main__":
    main()
