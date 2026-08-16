# -*- coding: utf-8 -*-
"""1688 货源采集（经 WebBridge daemon）：3 词搜索页 + 每词 top2 商品页"""
import json, io, time, urllib.request, urllib.parse, glob

def cmd(action, args, timeout=60):
    body = json.dumps({"action": action, "args": args, "session": "src-1688"}).encode("utf-8")
    req = urllib.request.Request("http://127.0.0.1:10086/command", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))

WORDS = [
    {"id": "carb6l2-1", "cn": "6L2-W0093修理包", "kw": "6L2-W0093 化油器修理包"},
    {"id": "carb6l2-2", "cn": "雅马哈20/25马力修理包", "kw": "雅马哈 20 25马力 船外机 化油器 修理包"},
    {"id": "carb6l2-3", "cn": "Yamaha 20 25 化油器修理包", "kw": "Yamaha 20 25 化油器修理包 舷外机"},
]

# 搜索页卡片提取：offerId 链接 + 卡片文本（价格/起批量/供应商）
SEARCH_EXTRACT = r"""(() => {
  const as=[...document.querySelectorAll('a[href*="offerId="], a[href*="detail.1688.com"]')];
  const seen=new Map();
  for (const a of as){
    const m=(a.href||'').match(/offerId=(\d+)/) || (a.href||'').match(/offer\/(\d+)/);
    if(!m) continue;
    const url='https://detail.1688.com/offer/'+m[1]+'.html';
    if(seen.has(url)) continue;
    let card=a;
    for(let i=0;i<6;i++){ if((card.innerText||'').includes('¥')) break; if(card.parentElement) card=card.parentElement; }
    const t=(card.innerText||'').replace(/\s+/g,' ').slice(0,300);
    if(t.length>10) seen.set(url,t);
  }
  return JSON.stringify({count:seen.size, items:[...seen.entries()].slice(0,15).map(([u,t])=>({u,t}))});
})()"""

# 商品页提取：标题/价格/规格参数文本/图片数
OFFER_EXTRACT = r"""(() => {
  const txt=(document.body.innerText||'').replace(/\s+/g,' ');
  const imgs=[...document.querySelectorAll('img')].map(i=>i.src||i.getAttribute('data-src')||'').filter(s=>s.includes('alicdn'));
  const specs=[];
  document.querySelectorAll('[class*="prop"],[class*="spec"],[class*="attr"],table tr').forEach(e=>{
    const t=(e.innerText||'').replace(/\s+/g,' ').trim();
    if(t.length>2 && t.length<200) specs.push(t);
  });
  return JSON.stringify({title:document.title.slice(0,120), textHead:txt.slice(0,800), specCount:specs.length, specs:specs.slice(0,30), imgCount:imgs.length});
})()"""

out_dir = "temp/src-1688-gen"
import os
os.makedirs(out_dir, exist_ok=True)

for w in WORDS:
    t0 = time.time()
    try:
        gbk = urllib.parse.quote(w["kw"].encode("gbk"))
        url = "https://s.1688.com/selloffer/offer_search.htm?keywords=" + gbk
        cmd("navigate", {"url": url})
        time.sleep(5)
        cmd("evaluate", {"code": "(()=>{window.scrollTo(0,2000);return 1})()"})
        time.sleep(2)
        res = cmd("evaluate", {"code": SEARCH_EXTRACT})
        val = json.loads(res.get("data", {}).get("value", "{}"))
        io.open(f"{out_dir}/search-{w['id']}.json", "w", encoding="utf-8").write(
            json.dumps({**w, **val}, ensure_ascii=False, indent=2))
        print(f"#{w['id']} 搜索: {val.get('count','ERR')} 卡片 ({time.time()-t0:.1f}s)", flush=True)

        # top2 商品页
        for j, it in enumerate(val.get("items", [])[:2]):
            try:
                cmd("navigate", {"url": it["u"]})
                time.sleep(5)
                r2 = cmd("evaluate", {"code": OFFER_EXTRACT})
                v2 = json.loads(r2.get("data", {}).get("value", "{}"))
                io.open(f"{out_dir}/offer-{w['id']}-{j+1}.json", "w", encoding="utf-8").write(
                    json.dumps({"url": it["u"], "card": it["t"], **v2}, ensure_ascii=False, indent=2))
                print(f"  商品{j+1}: {v2.get('title','?')[:40]} specs={v2.get('specCount')} imgs={v2.get('imgCount')}", flush=True)
            except Exception as e:
                print(f"  商品{j+1} FAIL: {str(e)[:60]}", flush=True)
    except Exception as e:
        print(f"#{w['id']} FAIL: {str(e)[:80]}", flush=True)
print("done")
