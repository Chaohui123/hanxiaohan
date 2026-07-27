# ============================================================
# ONZO 商品视频俄文化 — strip the original (Chinese) audio track and burn
# Russian subtitles into a 1688 source video, ready for Ozon upload.
#
# Usage:
#   python scripts/make-video-ru.py <输入视频> <输出mp4> [字幕.srt]
#
# - 字幕文件缺省时使用内置模板（车载支架安装步骤）；自定义请传 UTF-8 SRT。
# - 音轨始终移除（Ozon 视频自动播放无声）；画面比例/时长保持原样。
# - 需要 ffmpeg + libass（gyan.dev full build 已含）。
# ============================================================
import subprocess, os, sys

SRC = sys.argv[1] if len(sys.argv) > 1 else None
OUT = sys.argv[2] if len(sys.argv) > 2 else None
SRT_IN = sys.argv[3] if len(sys.argv) > 3 else None
if not SRC or not OUT:
    sys.exit("用法: python scripts/make-video-ru.py <输入视频> <输出mp4> [字幕.srt]")

DEFAULT_SRT = """1
00:00:00,000 --> 00:00:08,000
Магнитный держатель для телефона — установка за пару минут

2
00:00:08,000 --> 00:00:18,000
Шаг 1. Соберите шарнир и магнитную головку

3
00:00:18,000 --> 00:00:32,000
Шаг 2. Прижмите присоску к чистому стеклу и поверните фиксатор

4
00:00:32,000 --> 00:00:46,000
Шаг 3. Приложите телефон — магнит зафиксирует его сам

5
00:00:46,000 --> 00:00:54,000
Поверните на 360° и выберите удобный угол

6
00:00:54,000 --> 00:00:59,600
Готово! Навигатор всегда перед глазами
"""

WORK = os.path.join(os.path.dirname(os.path.abspath(OUT)), ".video-ru-tmp")
os.makedirs(WORK, exist_ok=True)

if SRT_IN:
    with open(SRT_IN, "r", encoding="utf-8-sig") as f:
        srt = f.read()
else:
    srt = DEFAULT_SRT
srt_path = os.path.join(WORK, "subs.srt")
with open(srt_path, "w", encoding="utf-8-sig") as f:
    f.write(srt)

vf = ("subtitles=subs.srt:force_style='FontName=Arial,FontSize=21,"
      "PrimaryColour=&H00FFFFFF,OutlineColour=&H90000000,BorderStyle=3,"
      "Outline=1,Shadow=0,MarginV=46,Alignment=2'")
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", SRC, "-vf", vf,
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "21", "-an",
                os.path.abspath(OUT)], check=True, cwd=WORK)

dur = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration,size",
                      "-of", "csv=p=0", os.path.abspath(OUT)], capture_output=True, text=True).stdout.strip()
print("OK:", os.path.abspath(OUT), "|", dur)
