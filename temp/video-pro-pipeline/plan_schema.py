import json
import math
import os
from pathlib import Path
import re
from dataclasses import dataclass

from media_common import audio_streams, probe_media, sha256_file, stream_fps, video_duration, video_stream
from pipeline_errors import PlanError


COVER_PURPOSES = ("what", "structure", "use", "check")


@dataclass(frozen=True)
class Clip:
    clip_id: str
    path: Path
    sha256: str
    duration: float
    width: int
    height: int
    fps: float
    raw: dict


@dataclass(frozen=True)
class VideoPlan:
    path: Path
    root: Path
    output_root: Path
    sku: str
    fps: int
    spec: dict
    clips: dict
    cover: list
    main: list
    voice: dict
    raw: dict


def _required(mapping, key, owner):
    if key not in mapping:
        raise PlanError(f"{owner} 缺少字段 {key}")
    return mapping[key]


def _number(value, owner, minimum=0.0):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise PlanError(f"{owner} 必须是有限数值")
    if value < minimum:
        raise PlanError(f"{owner} 不能小于 {minimum}")
    return float(value)


def _integer(value, owner, minimum=1):
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise PlanError(f"{owner} 必须是 >= {minimum} 的整数")
    return value


def _text(value, owner):
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise PlanError(f"{owner} 必须是非空文本")
    return value.strip()


def _reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise PlanError(f"JSON 存在重复键: {key}")
        result[key] = value
    return result


def _validate_spec(raw):
    raw = dict(raw)
    width = _integer(_required(raw, "width", "spec"), "spec.width", 16)
    height = _integer(_required(raw, "height", "spec"), "spec.height", 16)
    if (width, height) != (1080, 1440):
        raise PlanError("双片规格必须固定为 1080×1440（竖版 3:4），不能只满足比例或长边范围")
    if not 1080 <= max(width, height) <= 1920:
        raise PlanError("视频长边必须在 1080–1920 像素")
    maximum = _integer(_required(raw, "max_bytes", "spec"), "spec.max_bytes", 1000)
    if maximum > 18_000_000:
        raise PlanError("内部字节上限不能超过 18,000,000")
    expected = {"container": "mp4", "video_codec": "h264", "pixel_format": "yuv420p"}
    for key, value in expected.items():
        if _required(raw, key, "spec") != value:
            raise PlanError(f"spec.{key} 必须为 {value}")
    if _required(raw, "faststart", "spec") is not True:
        raise PlanError("spec.faststart 必须为 true")
    raw["audio_bitrate"] = _integer(raw.get("audio_bitrate", 128000), "spec.audio_bitrate", 32000)
    if raw["audio_bitrate"] > 192000:
        raise PlanError("spec.audio_bitrate 不能超过 192000")
    raw["font_path"] = _text(raw.get("font_path", "C:/Windows/Fonts/arialbd.ttf"), "spec.font_path")
    if not Path(raw["font_path"]).is_file():
        raise PlanError(f"字体文件不存在: {raw['font_path']}")
    return raw


def _aspect_ratio(width, height):
    divisor = math.gcd(width, height)
    return f"{width // divisor}:{height // divisor}"


def _validate_reframe(item, clip_id, width, height, spec):
    if width * spec["height"] == height * spec["width"]:
        return
    detail = (f"源片与成品不是同一比例: clip {clip_id} "
              f"source={width}x{height} ({_aspect_ratio(width, height)}), "
              f"target={spec['width']}x{spec['height']} ({_aspect_ratio(spec['width'], spec['height'])})")
    reframe = item.get("reframe")
    if not isinstance(reframe, dict):
        raise PlanError(f"{detail}；必须提供 reframe 对象，禁止未经安全确认直接居中裁切")
    if reframe.get("mode") != "center_crop":
        raise PlanError(f"{detail}；reframe.mode 必须为 center_crop，禁止 pad、拉伸或其他模式")
    if reframe.get("safe_center") is not True:
        raise PlanError(f"{detail}；reframe.safe_center 必须显式为 true，且主体完整性仍须人工目检")


def _load_clip(item, root, plan_fps, spec):
    if not isinstance(item, dict):
        raise PlanError("clips 每项必须是对象")
    clip_id = _text(_required(item, "id", "clip"), "clip.id")
    if not re.fullmatch(r"[A-Za-z0-9._-]+", clip_id):
        raise PlanError(f"clip.id 含非法字符: {clip_id}")
    raw_path = _text(_required(item, "path", f"clip {clip_id}"), f"clip {clip_id}.path")
    path = Path(raw_path)
    if not path.is_absolute():
        path = root / path
    path = path.resolve()
    if not path.is_file():
        raise PlanError(f"素材不存在: {path}")
    expected_hash = _text(_required(item, "sha256", f"clip {clip_id}"), f"clip {clip_id}.sha256").lower()
    if not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
        raise PlanError(f"clip {clip_id} 的 SHA256 格式无效")
    actual_hash = sha256_file(path)
    if actual_hash != expected_hash:
        raise PlanError(f"素材 SHA256 不匹配: {clip_id}: expected={expected_hash} actual={actual_hash}")
    probe = probe_media(path, count_frames=True)
    stream = video_stream(probe)
    if audio_streams(probe) and item.get("allow_source_audio") is not True:
        raise PlanError(f"素材 {clip_id} 自带音轨；请明确 allow_source_audio=true，成片仍会移除源音轨")
    duration = video_duration(probe)
    width = int(stream["width"])
    height = int(stream["height"])
    fps = stream_fps(stream)
    declared_duration = _number(_required(item, "duration", f"clip {clip_id}"), f"clip {clip_id}.duration", 0.01)
    declared_width = _integer(_required(item, "width", f"clip {clip_id}"), f"clip {clip_id}.width")
    declared_height = _integer(_required(item, "height", f"clip {clip_id}"), f"clip {clip_id}.height")
    declared_fps = _number(_required(item, "fps", f"clip {clip_id}"), f"clip {clip_id}.fps", 1)
    if abs(duration - declared_duration) > 1.0 / plan_fps + 0.02:
        raise PlanError(f"素材时长与清单不一致: {clip_id}: declared={declared_duration} actual={duration}")
    if (width, height) != (declared_width, declared_height):
        raise PlanError(f"素材尺寸与清单不一致: {clip_id}: actual={width}x{height}")
    if abs(fps - declared_fps) > 0.001 or abs(fps - plan_fps) > 0.001:
        raise PlanError(f"素材帧率与 plan 不一致: {clip_id}: plan={plan_fps} actual={fps}")
    if plan_fps not in (24, 30):
        raise PlanError("fps 只能为 24 或 30")
    _validate_reframe(item, clip_id, width, height, spec)
    return Clip(clip_id, path, actual_hash, duration, width, height, fps, dict(item))


def _shot_clip(shot, clips, owner):
    clip_id = _text(_required(shot, "clip", owner), f"{owner}.clip")
    if clip_id not in clips:
        raise PlanError(f"{owner} 引用了不存在的素材: {clip_id}")
    start = _number(shot.get("start", 0), f"{owner}.start", 0)
    return clip_id, clips[clip_id], start


def _validate_cover(raw, clips, fps):
    shots = _required(raw, "shots", "cover")
    if not isinstance(shots, list) or len(shots) != 4:
        raise PlanError("cover.shots 必须恰好 4 段：是什么/结构/使用/核对")
    normalized = []
    total = 0.0
    intervals = {}
    for index, (shot, purpose) in enumerate(zip(shots, COVER_PURPOSES)):
        owner = f"cover.shots[{index}]"
        if not isinstance(shot, dict):
            raise PlanError(f"{owner} 必须是对象")
        if _required(shot, "purpose", owner) != purpose:
            raise PlanError(f"{owner}.purpose 必须为 {purpose}")
        clip_id, clip, start = _shot_clip(shot, clips, owner)
        duration = _number(_required(shot, "duration", owner), f"{owner}.duration", 0.5)
        if abs(duration * fps - round(duration * fps)) > 1e-5:
            raise PlanError(f"{owner}.duration 必须按 {fps}fps 整帧对齐")
        end = start + duration
        if end > clip.duration + 1e-6:
            raise PlanError(f"{owner} 超过素材实际画面长度，禁止循环或定格补时: {clip_id}")
        for old_start, old_end in intervals.get(clip_id, []):
            if start < old_end - 1e-9 and old_start < end - 1e-9:
                raise PlanError(f"{owner} 封面素材区间重叠（含重复镜头）: {clip_id}")
        intervals.setdefault(clip_id, []).append((start, end))
        label = _text(_required(shot, "label", owner), f"{owner}.label")
        normalized.append({**shot, "clip": clip_id, "start": start, "duration": duration,
                           "label": label, "purpose": purpose})
        total += duration
    if not 12.0 - 1e-6 <= total <= 15.0 + 1e-6:
        raise PlanError(f"封面目标总时长必须为 12–15 秒，当前 {total:.3f}s")
    return normalized


def _validate_main(raw, clips):
    voice = _required(raw, "voice", "main")
    if not isinstance(voice, dict):
        raise PlanError("main.voice 必须是对象")
    if _required(voice, "provider", "main.voice") != "yandex":
        raise PlanError("正常视频只接受 Yandex SpeechKit 原速配音；旧 Edge/GLM 配置须显式迁移")
    if _required(voice, "model", "main.voice") != "speechkit-v3":
        raise PlanError("main.voice.model 必须为 speechkit-v3")
    if _text(_required(voice, "name", "main.voice"), "main.voice.name") != "marina":
        raise PlanError("main.voice.name 必须为 marina")
    if _required(voice, "role", "main.voice") != "friendly":
        raise PlanError("main.voice.role 必须为 friendly")
    if _required(voice, "rate", "main.voice") != "+0%":
        raise PlanError("SpeechKit 配音必须原速 rate=+0%，禁止变速")
    if "stt_verify" in voice and not isinstance(voice["stt_verify"], bool):
        raise PlanError("main.voice.stt_verify 必须为布尔值；仅首次验收或高风险配音显式开启")
    voice["stt_verify"] = voice.get("stt_verify", False)
    shots = _required(raw, "shots", "main")
    if not isinstance(shots, list) or not 4 <= len(shots) <= 6:
        raise PlanError("main.shots 必须为 4–6 段")
    normalized = []
    seen = set()
    for index, shot in enumerate(shots):
        owner = f"main.shots[{index}]"
        if not isinstance(shot, dict):
            raise PlanError(f"{owner} 必须是对象")
        clip_id, clip, start = _shot_clip(shot, clips, owner)
        if start >= clip.duration:
            raise PlanError(f"{owner}.start 超出素材长度: {clip_id}")
        speech = _text(_required(shot, "voice", owner), f"{owner}.voice")
        subtitle = _text(_required(shot, "subtitles", owner), f"{owner}.subtitles")
        key = (clip_id, round(start, 6))
        if key in seen:
            raise PlanError(f"正片存在重复素材起点，疑似循环复用: {clip_id}")
        seen.add(key)
        normalized.append({**shot, "clip": clip_id, "start": start,
                           "voice": speech, "subtitles": subtitle})
    return voice, normalized


def load_plan(path):
    candidate = Path(path)
    if candidate.suffix.lower() != ".json":
        raise PlanError("旧 slug/GLM 入口已停用；只接受 python run_one.py <path/to/video-plan.json>")
    if not candidate.is_file():
        raise PlanError(f"plan 文件不存在: {candidate}")
    candidate = candidate.resolve()
    try:
        raw = json.loads(candidate.read_text(encoding="utf-8"), object_pairs_hook=_reject_duplicate_keys)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PlanError(f"无法读取 plan: {candidate}: {exc}") from exc
    if not isinstance(raw, dict):
        raise PlanError("plan 顶层必须是对象")
    if _required(raw, "schema_version", "plan") != 1:
        raise PlanError("schema_version 必须为 1")
    sku = _text(_required(raw, "sku", "plan"), "sku")
    if not re.fullmatch(r"[A-Za-z0-9._-]+", sku):
        raise PlanError("SKU 只能包含字母、数字、点、下划线和连字符")
    fps = _integer(_required(raw, "fps", "plan"), "fps", 1)
    if fps not in (24, 30):
        raise PlanError("fps 只能为 24 或 30，且同一 SKU 双片一致")
    spec = _validate_spec(_required(raw, "spec", "plan"))
    output_value = raw.get("output_dir", ".")
    output_relative = Path(_text(output_value, "output_dir"))
    if output_relative.is_absolute() or ".." in output_relative.parts:
        raise PlanError("output_dir 必须是 plan 目录内的相对路径")
    output_root = (candidate.parent / output_relative).resolve()
    if os.path.commonpath([str(candidate.parent), str(output_root)]) != str(candidate.parent):
        raise PlanError("output_dir 不能逃出 plan 目录")
    clips_raw = _required(raw, "clips", "plan")
    if not isinstance(clips_raw, list) or not clips_raw:
        raise PlanError("clips 必须是非空数组")
    clips = {}
    for item in clips_raw:
        clip = _load_clip(item, candidate.parent, fps, spec)
        if clip.clip_id in clips:
            raise PlanError(f"重复素材 id: {clip.clip_id}")
        clips[clip.clip_id] = clip
    cover = _validate_cover(_required(raw, "cover", "plan"), clips, fps)
    voice, main = _validate_main(_required(raw, "main", "plan"), clips)
    return VideoPlan(candidate, candidate.parent, output_root, sku, fps, spec,
                     clips, cover, main, voice, raw)
