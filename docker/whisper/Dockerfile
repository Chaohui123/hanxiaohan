# ============================================================
# Whisper 转录服务 — 无字幕视频的语音转文本（CPU, faster-whisper base）
# 供 api-services 每日学习流水线内部调用（POST /transcribe {audioUrl}）
# 模型在构建时通过 hf-mirror 预下载（国内直连 huggingface 不通）
# ============================================================
FROM python:3.11-slim

# debian 源换阿里云（国内服务器，官方源超时 2026-09-05 实证）
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true

# ffmpeg：m4s/mp4 → wav 转码（faster-whisper 直接读 wav 最稳）
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

# pip 清华源（国内服务器）；yt-dlp 供 /transcribe-youtube 抓 YouTube 字幕/音频（2026-10-11 新增）
RUN pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple \
    && pip install --no-cache-dir faster-whisper fastapi "uvicorn[standard]" yt-dlp

# 模型本地预置（2026-10-11 实证：构建期下载全部卡死——hf-mirror 卡 2.4h、代理 32 分钟续传失败）
# 模型 4 文件预置在 docker/whisper/hf-model/（服务器本地文件，git 不跟踪；huggingface 下载仅一次性）
COPY hf-model/ /app/hf-model/
ENV WHISPER_MODEL_PATH=/app/hf-model

WORKDIR /app
COPY app.py /app/app.py

EXPOSE 9200
# base 模型 CPU 推理内存约 1GB；单并发足够（每日学习任务量小）
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9200", "--workers", "1"]
