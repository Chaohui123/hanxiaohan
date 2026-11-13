# -*- coding: utf-8 -*-
# GLM 清影(cogvideox-flash) 文生视频 B-roll 生成 —— 通用版(由 188F glm_broll.py 泛化)
# 用法: python glm_broll.py <slug>   —— 提交该品 3 段任务, 轮询到全部完成, 下载到 <品目录>/pro-assets/
# 与 188F 版差异: prompt/输出目录全部走 products.py 配置; submit 失败加重试(188F 版 submit 失败即丢任务)
# 注意: 不要传 quality 参数(传了报 1214)
import json, os, sys, time, urllib.request, urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from products import PRODUCTS

KEY = "ac4d6264533045b5870f2a8706d5dfa6.KJq0h4JRSlNwf5Z2"
SUBMIT_URL = "https://open.bigmodel.cn/api/paas/v4/videos/generations"
POLL_URL = "https://open.bigmodel.cn/api/paas/v4/async-result/"
ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


def post_json(url, payload):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"},
        method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def get_json(url):
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + KEY})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def download(url, path):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=180) as r, open(path, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)


def submit(name, prompt):
    """提交任务, 失败最多重试 3 次(限流/网络抖动)"""
    body = {"model": "cogvideox-flash", "prompt": prompt,
            "with_audio": False, "duration": 5, "size": "1280x720"}
    for attempt in range(3):
        try:
            resp = post_json(SUBMIT_URL, body)
            tid = resp.get("id")
            print(f"[{name}] submitted task_id={tid} status={resp.get('task_status')}", flush=True)
            return tid
        except urllib.error.HTTPError as e:
            print(f"[{name}] submit HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:300]}", flush=True)
        except Exception as e:
            print(f"[{name}] submit error: {e}", flush=True)
        time.sleep(10)
    return None


def main(slug):
    cfg = PRODUCTS[slug]
    out_dir = os.path.join(ROOT, cfg["dir"], "pro-assets")
    os.makedirs(out_dir, exist_ok=True)

    tasks = {}
    for name, prompt in cfg["broll"]:
        out = os.path.join(out_dir, name)
        if os.path.exists(out) and os.path.getsize(out) > 100000:
            print(f"[{name}] already exists, skip", flush=True)   # 已有成品跳过, 便于失败重跑
            continue
        tid = submit(name, prompt)
        if tid:
            tasks[tid] = (name, prompt)

    deadline = time.time() + 1500  # 最多等 25 分钟
    while tasks and time.time() < deadline:
        time.sleep(15)
        for tid in list(tasks.keys()):
            name, prompt = tasks[tid]
            try:
                st = get_json(POLL_URL + tid)
            except Exception as e:
                print(f"[{name}] poll error: {e}", flush=True)
                continue
            status = st.get("task_status")
            print(f"[{name}] status={status}", flush=True)
            if status == "SUCCESS":
                url = (st.get("video_result") or [{}])[0].get("url")
                if url:
                    out = os.path.join(out_dir, name)
                    try:
                        download(url, out)
                        print(f"[{name}] downloaded -> {out} ({os.path.getsize(out)} bytes)", flush=True)
                    except Exception as e:
                        print(f"[{name}] download error: {e}", flush=True)
                tasks.pop(tid)
            elif status == "FAIL":
                print(f"[{name}] FAILED, resubmitting once", flush=True)
                tasks.pop(tid)
                ntid = submit(name, prompt)
                if ntid:
                    tasks[ntid] = (name, prompt)

    if tasks:
        print(f"TIMEOUT, unfinished: {list(tasks.values())}", flush=True)
        sys.exit(2)
    print("BROLL_DONE", flush=True)


if __name__ == "__main__":
    main(sys.argv[1])
