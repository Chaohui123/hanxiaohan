# -*- coding: utf-8 -*-
"""WebBridge 通用调用（打印完整响应 data）：python temp/wb2.py <请求json文件> [超时秒]"""
import json, sys, urllib.request
sys.stdout.reconfigure(encoding="utf-8")

req_file = sys.argv[1]
timeout = int(sys.argv[2]) if len(sys.argv) > 2 else 90
args = json.load(open(req_file, encoding="utf-8"))
args.setdefault("session", "onzo-competitor-scan")
body = json.dumps(args, ensure_ascii=False).encode("utf-8")
req = urllib.request.Request("http://127.0.0.1:10086/command", data=body,
                             headers={"Content-Type": "application/json"})
with urllib.request.urlopen(req, timeout=timeout) as r:
    resp = json.loads(r.read().decode("utf-8"))
if resp.get("ok"):
    print(json.dumps(resp.get("data", {}), ensure_ascii=False)[:6000])
else:
    print("ERROR:", json.dumps(resp.get("error", {}), ensure_ascii=False)[:400])
    sys.exit(1)
