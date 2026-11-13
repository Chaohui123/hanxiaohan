# 历史 Edge 适配器，仅保留离线回归与人工显式兜底；run_one 当前调用 make_vo_yandex.py。
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

from media_common import audio_streams, probe_media, run_process
from pipeline_errors import MediaError
from plan_schema import load_plan


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
VENV_PY = ROOT / "temp" / "whisper-venv" / "Scripts" / "python.exe"
DEFAULT_VOICE = "ru-RU-SvetlanaNeural"


def _decoded_mp3_duration(path, sample_rate):
    result = run_process([
        "ffmpeg", "-hide_banner", "-v", "info", "-xerror", "-err_detect", "explode",
        "-i", str(path), "-map", "0:a:0", "-vn", "-af", "astats=metadata=0", "-f", "null", "-",
    ])
    samples = re.findall(r"Number of samples:\s*(\d+)", result.stderr)
    if not samples:
        raise MediaError(f"无法取得 MP3 实际解码样本数: {path}")
    duration = int(samples[-1]) / float(sample_rate)
    if not math.isfinite(duration) or duration <= 0:
        raise MediaError(f"MP3 实际解码时长无效: {path}: {duration}")
    return duration


def valid_mp3(path):
    path = Path(path)
    try:
        if not path.is_file() or path.stat().st_size == 0:
            return False
        probe = probe_media(path)
        declared = float(probe["format"]["duration"])
        streams = audio_streams(probe)
        if not math.isfinite(declared) or declared <= 0 or not streams:
            return False
        sample_rate = int(streams[0]["sample_rate"])
        if sample_rate <= 0:
            return False
        decoded = _decoded_mp3_duration(path, sample_rate)
        frame_samples = 1152 if sample_rate >= 32000 else 576
        if abs(decoded - declared) > 2 * frame_samples / sample_rate:
            return False
    except (MediaError, OSError, KeyError, TypeError, ValueError):
        return False
    return True


def generate_sentences(texts, out_dir, voice_config):
    if voice_config.get("provider") != "edge" or voice_config.get("model") != "edge-tts":
        raise MediaError("正片只允许 Edge edge-tts 原速配音")
    if voice_config.get("rate") != "+0%":
        raise MediaError("Edge 配音禁止 rate/变速，必须为 +0%")
    if not texts:
        raise MediaError("没有可生成的俄语配音文本")
    if not VENV_PY.is_file():
        raise MediaError(f"Edge TTS Python 不存在: {VENV_PY}")
    voice = voice_config.get("name", DEFAULT_VOICE)
    out_dir = Path(out_dir)
    temporary_root = out_dir.resolve()
    temporary_root.mkdir(parents=True, exist_ok=True)
    outputs = []
    for index, text in enumerate(texts, 1):
        output = out_dir / f"vo{index}.mp3"
        subtitles = out_dir / f"vo{index}.vtt"
        completed = False
        for attempt in range(3):
            attempt_dir = Path(tempfile.mkdtemp(prefix=f".vo{index}-attempt-", dir=temporary_root))
            temporary_output = attempt_dir / "voice.mp3"
            temporary_subtitles = attempt_dir / "voice.vtt"
            command = [str(VENV_PY), "-m", "edge_tts", "--text", text, "--voice", voice,
                       "--write-media", str(temporary_output),
                       "--write-subtitles", str(temporary_subtitles)]
            try:
                result = subprocess.run(command, capture_output=True, text=True, timeout=60,
                                        cwd=os.path.expanduser("~"))
                subtitles_ok = (temporary_subtitles.is_file() and
                                temporary_subtitles.stat().st_size > 0)
                if result.returncode == 0 and subtitles_ok and valid_mp3(temporary_output):
                    os.replace(temporary_subtitles, subtitles)
                    os.replace(temporary_output, output)
                    outputs.append(output)
                    completed = True
                    break
            except (OSError, subprocess.TimeoutExpired):
                pass
            finally:
                shutil.rmtree(attempt_dir, ignore_errors=True)
        if not completed:
            raise MediaError(f"Edge 配音失败 vo{index}，三次尝试均未得到本次完整 MP3/VTT")
    if len(outputs) != len(texts):
        raise MediaError("场景与 Edge 音频数量不一致")
    return outputs


def main(path):
    plan = load_plan(path)
    out_dir = plan.output_root / "main" / "work" / "voice-source"
    outputs = generate_sentences([shot["voice"] for shot in plan.main], out_dir, plan.voice)
    print("\n".join(str(path) for path in outputs))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("用法: python make_vo_edge.py <path/to/video-plan.json>；旧 slug 入口已停用")
    main(sys.argv[1])
