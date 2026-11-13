import math
from pathlib import Path
import struct
import subprocess
import wave

from PIL import Image, ImageDraw

from media_common import media_duration, probe_media, sha256_file, stream_fps, video_stream, write_json


DEFAULT_VOICE_DURATIONS = (5.0, 5.125, 5.0, 5.125)


def make_motion_clip(path, duration=9.0, fps=24, size=(270, 360), phase=0, static=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    width, height = size
    command = [
        "ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{width}x{height}", "-r", str(fps), "-i", "-", "-an",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", str(path),
    ]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                               stderr=subprocess.PIPE)
    try:
        for index in range(round(duration * fps)):
            t = index / fps
            image = Image.new("RGB", size, (20 + phase * 9 % 40, 42, 62 + phase * 7 % 35))
            draw = ImageDraw.Draw(image)
            if static:
                x, y, angle = 45, 90, 0
            else:
                x = 24 + int((width - 120) * (0.5 + 0.45 * math.sin(t * 1.7 + phase)))
                y = 70 + int((height - 220) * (0.5 + 0.40 * math.cos(t * 1.3 + phase)))
                angle = t * 55 + phase * 20
            draw.rounded_rectangle((x, y, x + 78, y + 112), radius=12,
                                   fill=(195, 209, 218), outline=(245, 248, 250), width=3)
            draw.ellipse((x + 17, y + 22, x + 61, y + 66), fill=(46, 74, 92))
            arm_x = x + 39 + int(55 * math.cos(math.radians(angle)))
            arm_y = y + 45 + int(55 * math.sin(math.radians(angle)))
            draw.line((x + 39, y + 45, arm_x, arm_y), fill=(245, 139, 31), width=8)
            draw.ellipse((arm_x - 9, arm_y - 9, arm_x + 9, arm_y + 9), fill=(250, 176, 80))
            if not static:
                marker = int((t * 47 + phase * 31) % width)
                draw.rectangle((marker, height - 44, min(width, marker + 34), height - 30),
                               fill=(74, 180, 157))
            process.stdin.write(image.tobytes())
        process.stdin.close()
        stderr = process.stderr.read().decode("utf-8", errors="replace")
        return_code = process.wait()
    except Exception:
        process.kill()
        process.wait()
        raise
    finally:
        if process.stdin and not process.stdin.closed:
            process.stdin.close()
        if process.stderr:
            process.stderr.close()
    if return_code != 0:
        raise RuntimeError(f"fixture ffmpeg failed: {stderr}")
    return path


def make_center_subject_clip(path, size, duration=9.0, fps=24):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    width, height = size
    side = max(16, (min(width, height) // 4) // 2 * 2)
    left = (width - side) // 2
    top = (height - side) // 2
    right = left + side - 1
    bottom = top + side - 1
    command = [
        "ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{width}x{height}", "-r", str(fps), "-i", "-", "-an",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", str(path),
    ]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                               stderr=subprocess.PIPE)
    try:
        for index in range(round(duration * fps)):
            image = Image.new("RGB", size, (18, 80, 58))
            draw = ImageDraw.Draw(image)
            draw.rectangle((left, top, right, bottom), fill=(238, 240, 232))
            marker_x = left + 2 + (index * 2) % max(1, side - 8)
            draw.rectangle((marker_x, bottom - 7, marker_x + 4, bottom - 3), fill=(224, 120, 28))
            process.stdin.write(image.tobytes())
        process.stdin.close()
        stderr = process.stderr.read().decode("utf-8", errors="replace")
        return_code = process.wait()
    except Exception:
        process.kill()
        process.wait()
        raise
    finally:
        if process.stdin and not process.stdin.closed:
            process.stdin.close()
        if process.stderr:
            process.stderr.close()
    if return_code != 0:
        raise RuntimeError(f"center-subject fixture ffmpeg failed: {stderr}")
    return path


def make_tone_wav(path, duration, frequency=440.0, sample_rate=24000):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = round(duration * sample_rate)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        block = bytearray()
        for index in range(frames):
            t = index / sample_rate
            envelope = min(1.0, t * 80, (frames - index - 1) / (sample_rate * 0.01) + 1)
            value = int(9000 * envelope * (math.sin(2 * math.pi * frequency * t) +
                                          0.25 * math.sin(2 * math.pi * frequency * 1.5 * t)))
            block.extend(struct.pack("<h", value))
            if len(block) >= 65536:
                handle.writeframes(block)
                block.clear()
        if block:
            handle.writeframes(block)
    return path


class OfflineVoiceFactory:
    def __init__(self, durations=DEFAULT_VOICE_DURATIONS):
        self.durations = list(durations)
        self.calls = []

    def __call__(self, texts, out_dir, voice_config):
        if voice_config["provider"] != "yandex" or voice_config["rate"] != "+0%":
            raise ValueError("offline fake only accepts original-speed SpeechKit config")
        self.calls.append({"texts": list(texts), "voice": dict(voice_config)})
        if len(texts) != len(self.durations):
            raise ValueError("offline duration count must match sentence count")
        outputs = []
        for index, (text, duration) in enumerate(zip(texts, self.durations), 1):
            outputs.append(make_tone_wav(Path(out_dir) / f"vo{index}.wav", duration,
                                         frequency=330 + index * 55))
        return outputs


def create_fixture_plan(directory, voice_durations=DEFAULT_VOICE_DURATIONS, fps=24,
                        max_bytes=18_000_000, static_clips=()):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    clips = []
    for index in range(1, 5):
        path = directory / "fixtures" / f"motion-{index}.mp4"
        make_motion_clip(path, fps=fps, phase=index, static=index in static_clips)
        probe = probe_media(path)
        stream = video_stream(probe)
        clips.append({
            "id": f"clip{index}",
            "path": str(path.relative_to(directory)),
            "sha256": sha256_file(path),
            "duration": media_duration(probe),
            "width": int(stream["width"]),
            "height": int(stream["height"]),
            "fps": stream_fps(stream),
            "generator": {"model": "offline-motion-fixture-v1", "prompt": "text-free geometric motion"},
        })
    speeches = [
        "Первый непрерывный кадр показывает общий вид детали.",
        "Второй кадр помогает рассмотреть конструкцию и соединения.",
        "Третий кадр показывает последовательность использования изделия.",
        "Перед заказом проверьте размеры и комплектацию по фотографиям.",
    ]
    subtitles = ["Общий вид детали", "Конструкция и соединения",
                 "Последовательность использования", "Проверьте размеры и комплект"]
    labels = ["Что это за деталь", "Конструкция крупным планом",
              "Как использовать", "Проверьте перед заказом"]
    plan = {
        "schema_version": 1,
        "sku": "OFFLINE-DUAL-TEST",
        "output_dir": ".",
        "fps": fps,
        "spec": {
            "width": 1080,
            "height": 1440,
            "max_bytes": max_bytes,
            "container": "mp4",
            "video_codec": "h264",
            "pixel_format": "yuv420p",
            "faststart": True,
            "audio_bitrate": 128000,
            "font_path": "C:/Windows/Fonts/arialbd.ttf",
        },
        "clips": clips,
        "cover": {
            "shots": [
                {"purpose": purpose, "clip": f"clip{index}", "start": 0,
                 "duration": 3.25, "label": labels[index - 1]}
                for index, purpose in enumerate(("what", "structure", "use", "check"), 1)
            ]
        },
        "main": {
            "voice": {"provider": "yandex", "model": "speechkit-v3",
                      "name": "marina", "role": "friendly", "rate": "+0%", "stt_verify": False},
            "shots": [
                {"clip": f"clip{index}", "start": 0.25, "voice": speeches[index - 1],
                 "subtitles": subtitles[index - 1]}
                for index in range(1, 5)
            ],
        },
    }
    path = directory / "video-plan.json"
    write_json(path, plan)
    return path
