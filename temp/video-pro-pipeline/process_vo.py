from pathlib import Path
import wave

from media_common import run_process
from pipeline_errors import MediaError


SILENCE_FILTER = (
    "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,"
    "areverse,"
    "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,"
    "areverse"
)


def wav_dur(path):
    try:
        with wave.open(str(path), "rb") as handle:
            rate = handle.getframerate()
            if rate <= 0:
                raise MediaError(f"无效 WAV 采样率: {path}")
            return handle.getnframes() / float(rate)
    except (OSError, wave.Error, EOFError) as exc:
        raise MediaError(f"无法读取完整 WAV: {path}: {exc}") from exc


def process_audio_files(sources, out_dir):
    if not sources:
        raise MediaError("正片没有任何配音文件")
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    outputs = []
    for index, source in enumerate(sources, 1):
        source = Path(source)
        if not source.is_file():
            raise MediaError(f"缺少所选配音源: {source}")
        output = out_dir / f"vo{index}-f.wav"
        run_process([
            "ffmpeg", "-y", "-v", "error", "-xerror", "-err_detect", "explode",
            "-i", str(source), "-af", SILENCE_FILTER,
            "-c:a", "pcm_s16le", str(output),
        ])
        if wav_dur(output) <= 0:
            raise MediaError(f"配音修剪后为空: {source}")
        outputs.append(output)
    return outputs


if __name__ == "__main__":
    raise SystemExit("process_vo.py 只由 build_video.py 正片分支调用；旧 slug/GLM 入口已停用")
