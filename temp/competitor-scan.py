# -*- coding: utf-8 -*-
"""
竞品链接精准监控抓取（本机 WebBridge 两段式，服务器 IP 被 Ozon 前台拦截，只能本机跑）

流程：服务器 GET /api/promo/competitor-links → WebBridge 逐个打开竞品页 →
页面内 JS 提取价格/评分/评论数 → 按我方 offerId 分组 POST /api/promo/competitor-snapshots 回传。

用法：
  python temp/competitor-scan.py              # 全量抓取（34 条约 8-10 分钟）
  python temp/competitor-scan.py MAR-YAM-67F-01  # 只抓某我方商品
前提：WebBridge daemon 运行 + Chrome 扩展已连接（127.0.0.1:10086）。
调度建议：每日 2 次（快照新鲜度 12h 内 competitor-watch 才会消费）。
"""
import json, os, sys, time, random, urllib.request, urllib.error, io
sys.stdout.reconfigure(encoding="utf-8")

WB = "http://127.0.0.1:10086/command"
SESSION = "onzo-competitor-scan"
HERE = os.path.dirname(os.path.abspath(__file__))
REQ_DIR = os.path.join(HERE, "competitor-scan-tmp")
os.makedirs(REQ_DIR, exist_ok=True)

# ---- 配置（从仓库根 .env 读取，不打印）----
def load_env():
    env = {}
    for name in (".env", ".env.production"):
        p = os.path.join(HERE, "..", name)
        if os.path.exists(p):
            for line in io.open(p, encoding="utf-8", errors="ignore"):
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env.setdefault(k.strip(), v.strip())
    return env

ENV = load_env()
API_BASE = os.environ.get("ONZO_API_BASE") or (
    "https://" + ENV.get("CADDY_DOMAIN", "") if ENV.get("CADDY_DOMAIN") else "https://huashangshangmao.top"
)
API_KEY = ENV.get("API_KEY", "")
if not API_KEY:
    print("FATAL: .env 缺少 API_KEY"); sys.exit(1)

EXTRACT = r"""
(() => {
  const t = document.body.innerText || '';
  const rev = t.match(/(\d[\d\s\u2009]*)\s*отзыв/);
  const reviews = rev ? parseInt(rev[1].replace(/[\s\u2009]/g, '')) : 0;
  let price = 0, bestSize = 0;
  for (const el of document.querySelectorAll('span,div')) {
    const x = (el.innerText || '').trim();
    const m = x.match(/^(\d[\d\s\u2009]*)\s*₽/);
    if (!m) continue;
    const p = parseInt(m[1].replace(/[\s\u2009]/g, ''));
    const s = parseFloat(getComputedStyle(el).fontSize) || 0;
    if (p > 0 && s >= bestSize) { bestSize = s; price = p; }
  }
  const rm = t.match(/(\d\.\d)\s*[\n\r]+\s*\d[\d\s\u2009]*\s*отзыв/);
  const rating = rm ? parseFloat(rm[1]) : 0;
  return JSON.stringify({ price, reviews, rating, title: document.title.slice(0, 80) });
})()
"""

def wb(action, args, timeout=90):
    """WebBridge 命令（请求文件方式防 Windows 非 ASCII 转义问题）"""
    path = os.path.join(REQ_DIR, f"req-{int(time.time()*1000)}-{random.randint(100,999)}.json")
    with io.open(path, "w", encoding="utf-8") as f:
        json.dump({"action": action, "args": args, "session": SESSION}, f, ensure_ascii=False)
    try:
        with open(path, "rb") as f:
            req = urllib.request.Request(WB, data=f.read(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            resp = json.loads(r.read().decode("utf-8"))
    finally:
        try: os.remove(path)
        except OSError: pass
    if not resp.get("ok"):
        raise RuntimeError(json.dumps(resp.get("error", {}), ensure_ascii=False)[:200])
    return resp.get("data", {})

def api(method, path, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(API_BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json", "X-API-Key": API_KEY})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))

def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    links = api("GET", "/api/promo/competitor-links" + (f"?offerId={only}" if only else ""))["items"]
    if not links:
        print("无竞品链接"); return
    print(f"待抓取 {len(links)} 条竞品链接（API: {API_BASE}）")

    results, failures = {}, []
    # 打开一次分组标签页后逐个复用同一 tab（不用 newTab，减少打扰）
    first = True
    for i, link in enumerate(links, 1):
        url, oid, name = link["competitorUrl"], link["offerId"], link.get("competitorName", "")
        try:
            args = {"url": url}
            if first:
                args["group_title"] = "ONZO 竞品监控抓取"
                first = False
            wb("navigate", args)
            time.sleep(random.uniform(4, 6))  # 等渲染 + 限流
            raw = wb("evaluate", {"code": EXTRACT})
            val = raw.get("value") if isinstance(raw, dict) else raw
            d = json.loads(val if isinstance(val, str) else json.dumps(val))
            if d["price"] <= 0:
                raise RuntimeError(f"价格提取失败 title={d.get('title','')[:40]}")
            results.setdefault(oid, []).append({
                "competitorUrl": url, "price": d["price"],
                "rating": d["rating"], "salesCount": d["reviews"],
            })
            print(f"[{i}/{len(links)}] OK {oid} <- {d['price']}₽ {d['reviews']}评 {name}")
        except Exception as e:
            failures.append((oid, url, str(e)[:100]))
            print(f"[{i}/{len(links)}] FAIL {oid} {url[-40:]}: {str(e)[:80]}")
        time.sleep(random.uniform(3, 5))

    # 按我方 offerId 分组回传
    for oid, snaps in results.items():
        try:
            r = api("POST", "/api/promo/competitor-snapshots", {"offerId": oid, "snapshots": snaps})
            print(f"回传 {oid}: {r.get('inserted')} 条快照")
        except Exception as e:
            print(f"回传失败 {oid}: {e}")

    print(f"\n完成: 成功 {sum(len(v) for v in results.values())} / {len(links)}, 失败 {len(failures)}")
    for oid, url, err in failures:
        print(f"  FAIL {oid} {url[-50:]} {err}")

if __name__ == "__main__":
    main()
