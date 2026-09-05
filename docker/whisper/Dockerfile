# ============================================================
# Whisper 转录服务 — 无字幕视频的语音转文本（CPU, faster-whisper base）
# 供 api-services 每日学习流水线内部调用（POST /transcribe {audioUrl}）
# 模型在构建时通过 hf-mirror 预下载（国内直连 huggingface 不通）
# ============================================================
FROM python:3.11-slim

# ffmpeg：m4s/mp4 → wav 转码（faster-whisper 直接读 wav 最稳）
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

# pip 清华源（国内服务器）
RUN pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple \
    && pip install --no-cache-dir faster-whisper fastapi "uvicorn[standard]"

# 预下载 base 模型（hf-mirror 镜像 + 禁 xet 后端）
ENV HF_ENDPOINT=https://hf-mirror.com \
    HF_HUB_DISABLE_XET=1
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8')"

WORKDIR /app
COPY app.py /app/app.py

EXPOSE 9200
# base 模型 CPU 推理内存约 1GB；单并发足够（每日学习任务量小）
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9200", "--workers", "1"]
