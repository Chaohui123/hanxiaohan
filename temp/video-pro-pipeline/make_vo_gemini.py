# -*- coding: utf-8 -*-
# Gemini 3.8 Flash TTS 可选配音: 逐句原速生成 voN.wav, 不改变 cfg["vo"] 文本或顺序
# 用法: python make_vo_gemini.py <slug>; GEMINI_TTS_VOICE 可覆盖默认 Sulafat
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "temp", "omni-gen"))

from products import PRODUCTS
from omni_gen import gen_speech


def main(slug):
    cfg = PRODUCTS[slug]
    out_dir = os.path.join(ROOT, cfg["dir"], "pro-assets")
    os.makedirs(out_dir, exist_ok=True)
    voice = os.environ.get("GEMINI_TTS_VOICE", "Sulafat").strip() or "Sulafat"
    for i, text in enumerate(cfg["vo"], 1):
        out = gen_speech(f"vo{i}", text, out_dir, voice=voice)
        print(f"[vo{i}.wav] saved {os.path.getsize(out)} bytes", flush=True)
    print("TTS_DONE", flush=True)


if __name__ == "__main__":
    main(sys.argv[1])
