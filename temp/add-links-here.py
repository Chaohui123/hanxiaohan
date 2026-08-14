# -*- coding: utf-8 -*-
"""在当前已打开的'添加链接'弹窗里批量粘贴竞品链接并提交（不刷新页面）。
用法：python temp/add-links-here.py <url1> [url2 ...]"""
import json, sys, time, urllib.request
sys.stdout.reconfigure(encoding="utf-8")

WB = "http://127.0.0.1:10086/command"
SESSION = "onzo-competitor-scan"

def wb(action, args, timeout=90):
    body = json.dumps({"action": action, "args": args, "session": SESSION}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(WB, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        resp = json.loads(r.read().decode("utf-8"))
    if not resp.get("ok"):
        raise RuntimeError(json.dumps(resp.get("error", {}), ensure_ascii=False)[:200])
    return resp.get("data", {})

def js(code):
    d = wb("evaluate", {"code": code})
    return d.get("value") if isinstance(d, dict) else d

def click_xy(x, y):
    wb("cdp", {"method": "Input.dispatchMouseEvent", "params": {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1}})
    wb("cdp", {"method": "Input.dispatchMouseEvent", "params": {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1}})

def add_btn_pos():
    pos = js("""
    (() => {
      const btns = [...document.querySelectorAll('button')].filter(b => (b.innerText || '').trim() === '添加');
      const dlg = btns.filter(b => { let p = b; for (let i = 0; i < 6 && p; i++) { if ((p.innerText || '').includes('您可添加其他平台') || (p.innerText || '').includes('待添加链接')) return true; p = p.parentElement; } return false; });
      const b = dlg[0] || btns[btns.length - 1];
      if (!b) return 'NO_BTN';
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    })()
    """)
    return json.loads(pos) if isinstance(pos, str) and pos.startswith('{') else None

def main():
    urls = sys.argv[1:]
    if not urls:
        print("no urls"); return
    ok = 0
    for url in urls:
        js("(document.querySelector(\"input[placeholder*='粘贴'], input[placeholder*='链接']\")||{focus(){}}).focus()")
        wb("cdp", {"method": "Input.insertText", "params": {"text": url}})
        time.sleep(1)
        p = add_btn_pos()
        if not p:
            print(f"! 添加按钮未找到 {url[-40:]}"); continue
        click_xy(p["x"], p["y"])
        time.sleep(2)
        ok += 1
        print(f"+ {url[-50:]}")
    pos = js("""
    (() => { const b = [...document.querySelectorAll('button')].find(b => (b.innerText || '').includes('发送以进行审核'));
      if (!b) return 'NO_SUBMIT'; const r = b.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()
    """)
    if isinstance(pos, str) and pos.startswith('{'):
        p = json.loads(pos)
        click_xy(p["x"], p["y"])
        time.sleep(4)
        print(f"✓ 已提交 {ok}/{len(urls)} 条审核")
    else:
        print(f"✗ 提交按钮未找到（已添加 {ok} 条到列表）")

if __name__ == "__main__":
    main()
