"""Whisper 转录服务：POST /transcribe {audioUrl} → 下载音频 → ffmpeg 转 wav → faster-whisper 转录"""
import os
import subprocess
import tempfile
import urllib.request

from fastapi import FastAPI
from pydantic import BaseModel
from faster_whisper import WhisperModel

app = FastAPI()
model = WhisperModel("base", device="cpu", compute_type="int8")

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"


class TranscribeRequest(BaseModel):
    audioUrl: str
    language: str = "zh"
    referer: str = "https://www.bilibili.com"


@app.get("/health")
def health():
    return {"status": "ok", "model": "base"}


@app.post("/transcribe")
def transcribe(req: TranscribeRequest):
    with tempfile.TemporaryDirectory() as tmp:
        raw = os.path.join(tmp, "audio.m4s")
        wav = os.path.join(tmp, "audio.wav")

        # 下载音频（B 站 playurl 直链需要 Referer）
        request = urllib.request.Request(req.audioUrl, headers={"User-Agent": UA, "Referer": req.referer})
        with urllib.request.urlopen(request, timeout=120) as resp, open(raw, "wb") as f:
            f.write(resp.read())

        # ffmpeg 转 16k 单声道 wav（whisper 最优输入）
        subprocess.run(
            ["ffmpeg", "-y", "-i", raw, "-vn", "-ac", "1", "-ar", "16000", wav],
            check=True, capture_output=True, timeout=180,
        )

        segments, info = model.transcribe(wav, language=req.language, vad_filter=True)
        parts = [{"start": round(s.start, 1), "end": round(s.end, 1), "text": s.text.strip()} for s in segments]
        return {
            "text": "\n".join(p["text"] for p in parts),
            "segments": parts,
            "language": info.language,
            "duration": round(info.duration, 1),
        }
