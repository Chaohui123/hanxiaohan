# ============================================================
# ONZO 素材分辨率审计 — classify downloaded 1688 images by resolution.
# 主图必须 ≥800px；400–799px 仅副图；<400px 一律弃用。
#
# Usage:
#   python scripts/filter-images.py "D:/下载/1688_<offerId>"
# Output: 分三档列出文件（HD / MID / LOW），并给出可直接用作图集的高清清单。
# ============================================================
import os, sys
from PIL import Image

root = sys.argv[1] if len(sys.argv) > 1 else None
if not root or not os.path.isdir(os.path.join(root, "images")):
    sys.exit('用法: python scripts/filter-images.py "D:/下载/1688_<offerId>"')

img_dir = os.path.join(root, "images")
hd, mid, low = [], [], []

for f in sorted(os.listdir(img_dir)):
    p = os.path.join(img_dir, f)
    try:
        with Image.open(p) as im:
            w, h = im.size
    except Exception:
        low.append((f, " unreadable", 0, 0))
        continue
    longest = max(w, h)
    if longest >= 800:
        hd.append((f, longest, w, h))
    elif longest >= 400:
        mid.append((f, longest, w, h))
    else:
        low.append((f, longest, w, h))

print(f"== HD 可直接用（≥800px，{len(hd)} 张）==")
for f, l, w, h in hd:
    print(f"  {f}  {w}x{h}")
print(f"== MID 仅副图（400–799px，{len(mid)} 张）==")
for f, l, w, h in mid:
    print(f"  {f}  {w}x{h}")
print(f"== LOW 弃用（<400px，{len(low)} 张）==")
for f, l, w, h in low:
    print(f"  {f}  {w}x{h}")

if len(hd) < 3:
    print(f"\n⚠️ 高清图仅 {len(hd)} 张（<3），图集偏薄——建议换素材更全的供应商，或走「卖点提炼俄文重制」补充。")
