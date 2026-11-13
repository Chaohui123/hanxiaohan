import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from media_common import run_process, sha256_file, write_json
from pipeline_errors import MediaError
from plan_schema import load_plan
from process_vo import wav_dur


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
SPEECHKIT_CLI = ROOT / "packages" / "yandex-cloud" / "dist" / "speechkit-cli.js"
STT_CLI = ROOT / "packages" / "yandex-cloud" / "dist" / "stt-cli.js"


def valid_wav(path):
    path = Path(path)
    try:
        if not path.is_file() or path.stat().st_size <= 44 or wav_dur(path) <= 0:
            return False
        run_process([
            "ffmpeg", "-hide_banner", "-v", "error", "-xerror", "-err_detect", "explode",
            "-i", str(path), "-map", "0:a:0", "-vn", "-f", "null", "-",
        ])
        return True
    except (MediaError, OSError):
        return False


def normalize_speech(value):
    import re
    return re.sub(r"\s+", " ", re.sub(r"[^\w]+", " ", value.lower().replace("ё", "е"), flags=re.UNICODE)).strip()


def verify_stt(wav_path, expected_text, attempt_dir, env):
    if not STT_CLI.is_file():
        raise MediaError(f"SpeechKit STT 客户端尚未构建: {STT_CLI}；先运行 pnpm build")
    ogg_path = attempt_dir / "voice.ogg"
    run_process([
        "ffmpeg", "-y", "-v", "error", "-xerror", "-err_detect", "explode",
        "-i", str(wav_path), "-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-ac", "1", str(ogg_path),
    ])
    request_path = attempt_dir / "stt-request.json"
    write_json(request_path, {"audio": str(ogg_path)})
    result = subprocess.run(
        ["node", str(STT_CLI), str(request_path)],
        capture_output=True, text=True, timeout=90, cwd=ROOT, env=env,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "unknown STT error")[-1000:]
        raise MediaError(f"SpeechKit STT 复核失败；不自动重发付费请求: {detail}")
    transcript = json.loads(result.stdout).get("text", "")
    if normalize_speech(transcript) != normalize_speech(expected_text):
        raise MediaError(f"SpeechKit STT 回读与原文不一致: expected={expected_text!r} actual={transcript!r}")
    return {"status": "PASS", "format": "oggopus", "transcript": transcript}


def generate_sentences(texts, out_dir, voice_config):
    if voice_config.get("provider") != "yandex" or voice_config.get("model") != "speechkit-v3":
        raise MediaError("正片只允许 Yandex SpeechKit v3 原速配音")
    if voice_config.get("name") != "marina" or voice_config.get("role") != "friendly":
        raise MediaError("SpeechKit 当前音色固定为 marina+friendly，禁止静默换音色")
    if voice_config.get("rate") != "+0%":
        raise MediaError("SpeechKit 配音禁止 rate/变速，必须为 +0%")
    if not texts:
        raise MediaError("没有可生成的俄语配音文本")
    if not SPEECHKIT_CLI.is_file():
        raise MediaError(f"SpeechKit 客户端尚未构建: {SPEECHKIT_CLI}；先运行 pnpm build")
    out_dir = Path(out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.setdefault("YANDEX_CLOUD_PROXY_URL", "http://127.0.0.1:10808")
    outputs = []
    for index, text in enumerate(texts, 1):
        output = out_dir / f"vo{index}.wav"
        attempt_dir = Path(tempfile.mkdtemp(prefix=f".vo{index}-speechkit-", dir=out_dir))
        try:
            temporary_output = attempt_dir / "voice.wav"
            request_path = attempt_dir / "request.json"
            write_json(request_path, {"text": text, "output": str(temporary_output)})
            result = subprocess.run(
                ["node", str(SPEECHKIT_CLI), str(request_path)],
                capture_output=True, text=True, timeout=90, cwd=ROOT, env=env,
            )
            if result.returncode != 0:
                detail = (result.stderr or result.stdout or "unknown SpeechKit error")[-1000:]
                raise MediaError(f"SpeechKit 配音失败 vo{index}；不自动重发付费请求: {detail}")
            if not valid_wav(temporary_output):
                raise MediaError(f"SpeechKit 配音失败 vo{index}：本次 WAV 未通过完整解码校验")
            stt_verification = None
            if voice_config.get("stt_verify") is True:
                stt_verification = verify_stt(temporary_output, text, attempt_dir, env)
            os.replace(temporary_output, output)
            receipt = json.loads(result.stdout)
            write_json(out_dir / f"vo{index}.speechkit.json", {
                **receipt,
                "text_sha256": __import__("hashlib").sha256(text.encode("utf-8")).hexdigest(),
                "audio_sha256": sha256_file(output),
                "rate": "+0%",
                "stt_verify_requested": voice_config.get("stt_verify", False),
                "stt_verification": stt_verification,
            })
            outputs.append(output)
        except subprocess.TimeoutExpired as exc:
            raise MediaError(f"SpeechKit 配音 vo{index} 超时，结果未确认；不自动重发") from exc
        finally:
            shutil.rmtree(attempt_dir, ignore_errors=True)
    if len(outputs) != len(texts):
        raise MediaError("场景与 SpeechKit 音频数量不一致")
    return outputs


def main(path):
    plan = load_plan(path)
    out_dir = plan.output_root / "main" / "work" / "voice-source"
    outputs = generate_sentences([shot["voice"] for shot in plan.main], out_dir, plan.voice)
    print("\n".join(str(path) for path in outputs))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("用法: python make_vo_yandex.py <path/to/video-plan.json>；旧 slug 入口已停用")
    main(sys.argv[1])
