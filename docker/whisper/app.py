"""Whisper 转录服务：
  POST /transcribe {audioUrl}         → 下载音频 → ffmpeg 转 wav → faster-whisper 转录（B 站等直链音频）
  POST /transcribe-youtube {videoUrl} → yt-dlp 字幕优先 / 无字幕走 bestaudio+whisper 兜底（2026-10-11 新增）
"""
import glob
import json
import os
import re
import subprocess
import tempfile
import urllib.request
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from faster_whisper import WhisperModel

app = FastAPI()
model = WhisperModel(os.environ.get("WHISPER_MODEL_PATH", "base"), device="cpu", compute_type="int8")

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


# ---- YouTube 转录（yt-dlp：字幕优先，无字幕走音频 whisper 兜底，2026-10-11 新增，供每日学习源 7 调用） ----
# yt-dlp 只在函数内 import：容器若缺 yt-dlp，/transcribe（B 站）端点仍可用，fail-open 不影响旧链路
# YouTube 生产直连不通，必须走代理：YT_PROXY 优先（默认 compose 网关 xray http 口），HTTPS_PROXY 兜底

YT_PROXY_DEFAULT = "http://172.28.0.1:10809"
YT_SUB_LANGS = ["ru", "ru-RU", "en"]  # 字幕语言偏好顺序（YT 源是俄语电商频道）
YT_MAX_SECONDS = 180  # 单视频处理总时限（yt-dlp 下载+转录），超时中断返回 502


class TranscribeYouTubeRequest(BaseModel):
    videoUrl: str
    language: str = "ru"  # whisper 兜底时的转录语种（默认俄语）


def _yt_proxy() -> str | None:
    """yt-dlp 代理：YT_PROXY > HTTPS_PROXY > 生产默认网关；显式 direct/none 关闭（本机调试用）"""
    p = os.environ.get("YT_PROXY") or os.environ.get("HTTPS_PROXY") or YT_PROXY_DEFAULT
    return None if p.strip().lower() in ("", "direct", "none") else p


def _add_cookies(opts: dict) -> None:
    """yt-dlp 登录态 cookies（YouTube 机房 IP 反爬「not a bot」绕行，2026-10-11 实证需要）：
    YT_COOKIES env 指定 Netscape cookies.txt 路径，文件存在才注入；无则不设（不影响匿名可用场景）"""
    cf = os.environ.get("YT_COOKIES", "").strip()
    if cf and os.path.exists(cf):
        opts["cookiefile"] = cf


def _pick_subtitle_lang(info: dict) -> tuple[str | None, bool]:
    """按偏好挑字幕语言，人工字幕优先于自动字幕。返回 (lang, is_auto)；无字幕 (None, False)"""
    subs = info.get("subtitles") or {}
    for lang in YT_SUB_LANGS:
        if subs.get(lang):
            return lang, False
    autos = info.get("automatic_captions") or {}
    for lang in YT_SUB_LANGS:
        if autos.get(lang):
            return lang, True
    return None, False


def _json3_to_text(raw: str) -> str:
    """YouTube json3 字幕 → 纯文本（events[].segs[].utf8 拼接）"""
    try:
        data = json.loads(raw)
    except ValueError:
        return ""
    lines = []
    for ev in data.get("events") or []:
        line = "".join(seg.get("utf8", "") for seg in (ev.get("segs") or [])).strip()
        if line:
            lines.append(line)
    return "\n".join(lines)


def _vtt_to_text(raw: str) -> str:
    """vtt 字幕 → 纯文本（去 header/时间戳/序号/内联标签；相邻行去重——YouTube 自动字幕滚动重复）"""
    lines: list[str] = []
    prev = None
    for line in raw.splitlines():
        line = line.strip()
        if not line or "-->" in line or line.startswith(("WEBVTT", "Kind:", "Language:")) or line.isdigit():
            continue
        line = re.sub(r"<[^>]+>", "", line).strip()
        if not line or line == prev:
            continue
        prev = line
        lines.append(line)
    return "\n".join(lines)


def _subtitle_file_to_text(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as f:
            raw = f.read()
    except OSError:
        return ""
    return _json3_to_text(raw) if path.endswith(".json3") else _vtt_to_text(raw)


def _download_subtitle(video_url: str, lang: str, auto: bool, tmp: str, proxy: str | None) -> str:
    """yt-dlp 只下载字幕文件（skip_download，不碰视频本体），返回纯文本；拿不到返回空串"""
    import yt_dlp

    opts = {
        "skip_download": True,
        "writesubtitles": not auto,
        "writeautomaticsub": auto,
        "subtitleslangs": [lang],
        "subtitlesformat": "json3/vtt",
        "outtmpl": os.path.join(tmp, "sub.%(ext)s"),
        "proxy": proxy,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "socket_timeout": 30,
        "retries": 2,
    }
    _add_cookies(opts)
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.extract_info(video_url, download=True)
    for path in sorted(glob.glob(os.path.join(tmp, "sub.*"))):
        text = _subtitle_file_to_text(path)
        if text:
            return text
    return ""


def _download_audio(video_url: str, tmp: str, proxy: str | None) -> str:
    """yt-dlp bestaudio 只下载音频轨，返回文件路径"""
    import yt_dlp

    opts = {
        "format": "bestaudio",
        "outtmpl": os.path.join(tmp, "audio.%(ext)s"),
        "proxy": proxy,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "socket_timeout": 30,
        "retries": 2,
    }
    _add_cookies(opts)
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.extract_info(video_url, download=True)
    files = sorted(glob.glob(os.path.join(tmp, "audio.*")))
    if not files:
        raise RuntimeError("yt-dlp audio download produced no file")
    return files[0]


def _youtube_transcribe(video_url: str, language: str) -> dict:
    """字幕优先，无字幕走 bestaudio + ffmpeg + whisper。返回 {text, source, duration}；失败抛异常由端点转 502"""
    import yt_dlp

    proxy = _yt_proxy()
    with tempfile.TemporaryDirectory() as tmp:
        # 元数据（字幕清单+时长）；download=False 不下载任何媒体
        meta_opts = {
            "skip_download": True, "proxy": proxy, "noplaylist": True,
            "quiet": True, "no_warnings": True, "socket_timeout": 30, "retries": 2,
        }
        with yt_dlp.YoutubeDL(meta_opts) as ydl:
            info = ydl.extract_info(video_url, download=False)

        # 1) 字幕优先（人工 > 自动）：有字幕直接返回文本，省 whisper CPU 转录
        lang, auto = _pick_subtitle_lang(info)
        if lang:
            text = _download_subtitle(video_url, lang, auto, tmp, proxy)
            if text:
                return {"text": text, "source": "subtitle", "duration": info.get("duration")}

        # 2) 无字幕 → bestaudio 下载 → ffmpeg 转 wav → whisper 转录（与 /transcribe 同路径）
        raw = _download_audio(video_url, tmp, proxy)
        wav = os.path.join(tmp, "audio.wav")
        subprocess.run(
            ["ffmpeg", "-y", "-i", raw, "-vn", "-ac", "1", "-ar", "16000", wav],
            check=True, capture_output=True, timeout=180,
        )
        segments, winfo = model.transcribe(wav, language=language, vad_filter=True)
        text = "\n".join(s.text.strip() for s in segments)
        return {"text": text, "source": "whisper", "duration": round(winfo.duration, 1)}


@app.post("/transcribe-youtube")
def transcribe_youtube(req: TranscribeYouTubeRequest):
    """YouTube 视频 → 文本（字幕优先/whisper 兜底）。任何失败返回 502 fail-open，调用方回退标题提炼"""
    executor = ThreadPoolExecutor(max_workers=1)
    future = executor.submit(_youtube_transcribe, req.videoUrl, req.language)
    try:
        return future.result(timeout=YT_MAX_SECONDS)
    except FutureTimeoutError:
        raise HTTPException(status_code=502, detail=f"timeout > {YT_MAX_SECONDS}s")
    except Exception as err:
        raise HTTPException(status_code=502, detail=str(err)[:300])
    finally:
        # 超时/失败后后台线程由 yt-dlp socket_timeout(30s) 与 ffmpeg timeout 兜底收尾，不阻塞响应
        executor.shutdown(wait=False)
