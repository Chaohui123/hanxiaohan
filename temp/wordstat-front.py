# -*- coding: utf-8 -*-
"""Yandex Wordstat Cloud API 查询；保留旧命令参数，不再打开前台或读取浏览器登录态。"""
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent


def main():
    if len(sys.argv) < 2:
        raise SystemExit('用法: python temp/wordstat-front.py "крыльчатка" [第二个词...]；数据来自 Cloud API')
    for phrase in sys.argv[1:]:
        output = ROOT / "temp" / f"wordstat-api-{int(time.time() * 1000)}.json"
        command = [
            "node", str(ROOT / "scripts" / "yandex-wordstat.mjs"),
            "--phrase", phrase, "--regions", "225", "--devices", "all",
            "--output", str(output),
        ]
        completed = subprocess.run(command, cwd=ROOT)
        if completed.returncode != 0:
            raise SystemExit(completed.returncode)
        result = json.loads(output.read_text(encoding="utf-8"))
        print(json.dumps({"phrase": phrase, "output": str(output), "data": result["data"]["top"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
