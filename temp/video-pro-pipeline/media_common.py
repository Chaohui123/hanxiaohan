import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import struct
import subprocess

from pipeline_errors import MediaError


def run_process(args, timeout=None, binary=False):
    kwargs = {
        "capture_output": True,
        "timeout": timeout,
    }
    if not binary:
        kwargs.update({"text": True, "encoding": "utf-8", "errors": "replace"})
    try:
        result = subprocess.run([str(arg) for arg in args], **kwargs)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise MediaError(f"命令执行失败: {args[0]}: {exc}") from exc
    if result.returncode != 0:
        if binary:
            detail = result.stderr.decode("utf-8", errors="replace")
        else:
            detail = result.stderr
        raise MediaError(
            f"命令失败(exit={result.returncode}): {Path(str(args[0])).name}\n{detail[-4000:]}"
        )
    return result


def strict_decode(path):
    return run_process([
        "ffmpeg", "-v", "error", "-xerror", "-err_detect", "explode",
        "-i", str(path), "-f", "null", "-",
    ])


def probe_media(path, count_frames=False):
    command = ["ffprobe", "-v", "error"]
    if count_frames:
        command.append("-count_frames")
    command.extend(["-show_streams", "-show_format", "-of", "json", str(path)])
    result = run_process(command)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise MediaError(f"ffprobe 返回无效 JSON: {path}") from exc


def video_stream(probe):
    streams = [stream for stream in probe.get("streams", []) if stream.get("codec_type") == "video"]
    if not streams:
        raise MediaError("文件没有视频流")
    return streams[0]


def audio_streams(probe):
    return [stream for stream in probe.get("streams", []) if stream.get("codec_type") == "audio"]


def _positive_duration(value):
    try:
        duration = float(value)
    except (TypeError, ValueError):
        return None
    return duration if math.isfinite(duration) and duration > 0 else None


def video_duration(probe):
    stream = video_stream(probe)
    for key in ("nb_read_frames", "nb_frames"):
        try:
            frames = int(stream.get(key, 0))
        except (TypeError, ValueError):
            continue
        if frames > 0:
            return frames / stream_fps(stream)
    duration = _positive_duration(stream.get("duration"))
    if duration is not None:
        return duration
    raise MediaError("无法从视频流时长或实际帧数确定画面时长")


def audio_duration(stream):
    duration = _positive_duration(stream.get("duration"))
    if duration is not None:
        return duration
    try:
        sample_rate = int(stream.get("sample_rate", 0))
        frame_size = int(stream.get("frame_size") or 0)
    except (TypeError, ValueError):
        sample_rate = 0
        frame_size = 0
    if frame_size <= 0 and stream.get("codec_name") == "aac":
        frame_size = 1024
    if sample_rate > 0 and frame_size > 0:
        for key in ("nb_read_frames", "nb_frames"):
            try:
                frames = int(stream.get(key, 0))
            except (TypeError, ValueError):
                continue
            if frames > 0:
                return frames * frame_size / sample_rate
    raise MediaError("无法从音频流确定时长")


def media_duration(probe):
    duration = _positive_duration(probe.get("format", {}).get("duration"))
    if duration is not None:
        return duration
    return video_duration(probe)


def fps_number(value):
    if isinstance(value, (int, float)):
        return float(value)
    numerator, denominator = str(value).split("/", 1)
    if float(denominator) == 0:
        raise MediaError(f"无效帧率: {value}")
    return float(numerator) / float(denominator)


def stream_fps(stream):
    value = stream.get("avg_frame_rate")
    if not value or value == "0/0":
        value = stream.get("r_frame_rate")
    return fps_number(value)


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def frame_duration(duration, fps):
    return math.ceil((float(duration) - 1e-7) * fps) / fps


def faststart_status(path):
    path = Path(path)
    try:
        file_size = path.stat().st_size
        with path.open("rb") as handle:
            offset = 0
            moov_before_mdat = False
            saw_moov = False
            while offset + 8 <= file_size:
                handle.seek(offset)
                header = handle.read(8)
                if len(header) != 8:
                    return False
                size, atom = struct.unpack(">I4s", header)
                header_size = 8
                if size == 1:
                    extended = handle.read(8)
                    if len(extended) != 8:
                        return False
                    size = struct.unpack(">Q", extended)[0]
                    header_size = 16
                elif size == 0:
                    size = file_size - offset
                if size < header_size or offset + size > file_size:
                    return False
                if atom == b"moov":
                    saw_moov = True
                    moov_before_mdat = True
                elif atom == b"mdat":
                    if saw_moov:
                        return moov_before_mdat
                    return False
                offset += size
    except OSError:
        return False
    return False


def pipeline_fingerprint(plan, role, source_names):
    payload = {
        "role": role,
        "plan": plan.raw,
        "assets": {key: clip.sha256 for key, clip in sorted(plan.clips.items())},
        "font_sha256": sha256_file(plan.spec["font_path"]),
        "sources": {},
    }
    here = Path(__file__).resolve().parent
    for name in source_names:
        path = here / name
        payload["sources"][name] = sha256_file(path)
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def cache_valid(final_path, metadata_path, manifest_path, fingerprint):
    final_path = Path(final_path)
    metadata_path = Path(metadata_path)
    manifest_path = Path(manifest_path)
    if not final_path.is_file() or not metadata_path.is_file() or not manifest_path.is_file():
        return False
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    if manifest.get("input_sha256") != fingerprint:
        return False
    return manifest.get("output_sha256") == sha256_file(final_path)


def render_video_shot(clip, start, duration, overlay, output, spec, fps):
    width = spec["width"]
    height = spec["height"]
    probe = probe_media(clip.path, count_frames=True)
    source_duration = video_duration(probe)
    if start < 0 or start + duration > source_duration + 1e-6:
        raise MediaError(
            f"素材不足: {clip.clip_id} start={start:.3f}s duration={duration:.3f}s "
            f"source={source_duration:.3f}s；禁止循环、慢放或定格补时"
        )
    filters = (
        f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos,"
        f"crop={width}:{height},setsar=1,fps={fps},format=yuv420p[base];"
        f"[base][1:v]overlay=0:0:eof_action=repeat[v]"
    )
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    run_process([
        "ffmpeg", "-y", "-v", "error", "-ss", f"{start:.6f}", "-i", str(clip.path),
        "-i", str(overlay), "-filter_complex_threads", "1", "-filter_complex", filters,
        "-map", "[v]", "-frames:v", str(round(duration * fps)), "-an", "-c:v", "libx264",
        "-preset", "veryfast", "-crf", "15", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", str(output),
    ])


def compose_timeline(segment_paths, output, spec, fps, audio_paths=None, audio_durations=None):
    audio_paths = audio_paths or []
    if audio_paths and len(audio_paths) != len(segment_paths):
        raise MediaError("场景与音频数量不一致")
    if audio_durations and len(audio_durations) != len(segment_paths):
        raise MediaError("场景与音频时长数量不一致")
    inputs = []
    for path in list(segment_paths) + list(audio_paths):
        inputs.extend(["-i", str(path)])
    count = len(segment_paths)
    filters = ["".join(f"[{index}:v]" for index in range(count)) + f"concat=n={count}:v=1:a=0[v]"]
    maps = ["-map", "[v]"]
    if audio_paths:
        offset = count
        for index, duration in enumerate(audio_durations):
            filters.append(
                f"[{offset + index}:a]aresample=48000,"
                f"aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo,"
                f"apad,atrim=duration={duration:.9f}[a{index}]"
            )
        filters.append("".join(f"[a{index}]" for index in range(count)) + f"concat=n={count}:v=0:a=1[a]")
        maps.extend(["-map", "[a]"])
    command = ["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex_threads", "1",
               "-filter_complex", ";".join(filters), *maps,
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p"]
    if audio_paths:
        command.extend(["-c:a", "aac", "-profile:a", "aac_low", "-b:a", str(spec["audio_bitrate"]),
                        "-ar", "48000", "-ac", "2"])
    else:
        command.append("-an")
    command.extend(["-movflags", "+faststart", str(output)])
    run_process(command)


def encode_with_budget(master, final, spec, has_audio):
    master = Path(master)
    final = Path(final)
    final.parent.mkdir(parents=True, exist_ok=True)
    maximum = int(spec["max_bytes"])
    if master.stat().st_size <= maximum:
        temporary = final.with_name(final.stem + ".tmp.mp4")
        shutil.copyfile(master, temporary)
        os.replace(temporary, final)
        return {"reencoded": False, "passes": 0, "video_bitrate": None, "bytes": final.stat().st_size}
    probe = probe_media(master, count_frames=True)
    duration = video_duration(probe)
    audio_bitrate = int(spec["audio_bitrate"]) if has_audio else 0
    reserve = max(32768, int(maximum * 0.04))
    audio_budget = audio_bitrate * duration / 8.0
    video_budget = maximum - reserve - audio_budget
    if video_budget <= 0:
        raise MediaError("目标字节预算连音轨和封装余量都容纳不下")
    bitrate = int(video_budget * 8 / duration)
    if bitrate < 20000:
        raise MediaError(f"目标字节预算过低，所需视频码率不足 20000bps: {bitrate}")
    passlog = final.parent / (final.stem + "-2pass")
    temporary = final.with_name(final.stem + ".tmp.mp4")
    original_bitrate = bitrate
    for attempt in range(3):
        base = ["ffmpeg", "-y", "-v", "error", "-i", str(master), "-map", "0:v:0",
                "-c:v", "libx264", "-preset", "medium", "-b:v", str(bitrate),
                "-pix_fmt", "yuv420p", "-passlogfile", str(passlog)]
        run_process([*base, "-an", "-pass", "1", "-f", "null", os.devnull])
        second = [*base, "-pass", "2"]
        if has_audio:
            second.extend(["-map", "0:a:0", "-c:a", "aac", "-profile:a", "aac_low",
                           "-b:a", str(audio_bitrate), "-ar", "48000", "-ac", "2"])
        else:
            second.append("-an")
        second.extend(["-movflags", "+faststart", str(temporary)])
        run_process(second)
        size = temporary.stat().st_size
        if size <= maximum:
            os.replace(temporary, final)
            return {"reencoded": True, "passes": 2 * (attempt + 1),
                    "video_bitrate": bitrate, "requested_video_bitrate": original_bitrate,
                    "bytes": size}
        bitrate = max(20000, int(bitrate * min(0.90, maximum / size * 0.94)))
    raise MediaError(f"三遍重编码后仍超过目标字节预算 {maximum}: {temporary.stat().st_size}")
