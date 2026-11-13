import json
import math
from pathlib import Path
import re
import sys
import wave

from media_common import (audio_duration, audio_streams, faststart_status, frame_duration,
                          media_duration, probe_media, run_process, sha256_file, stream_fps,
                          strict_decode, video_duration, video_stream, write_json)
from pipeline_errors import MediaError, MediaQCError, PipelineError
from plan_schema import load_plan
from process_vo import wav_dur


AAC_TIMELINE_TOLERANCE = 2 * 1024 / 48000


def _main_aac_valid(audios):
    return (len(audios) == 1 and audios[0].get("codec_name") == "aac" and
            audios[0].get("profile") == "LC" and audios[0].get("sample_rate") == "48000" and
            audios[0].get("channels") == 2)


def detect_freezes(path, duration):
    result = run_process([
        "ffmpeg", "-hide_banner", "-v", "info", "-xerror", "-err_detect", "explode",
        "-i", str(path), "-map", "0:v:0",
        "-vf", "freezedetect=n=-60dB:d=0.75", "-an", "-f", "null", "-",
    ])
    events = []
    current = None
    for line in result.stderr.splitlines():
        start = re.search(r"lavfi\.freezedetect\.freeze_start:\s*([0-9.]+)", line)
        end = re.search(r"lavfi\.freezedetect\.freeze_end:\s*([0-9.]+)", line)
        if start:
            current = float(start.group(1))
        elif end and current is not None:
            events.append({"start": current, "end": float(end.group(1)),
                           "duration": float(end.group(1)) - current})
            current = None
    if current is not None:
        events.append({"start": current, "end": duration, "duration": duration - current})
    return events


def _average_hash(frame):
    mean = sum(frame) / len(frame)
    return tuple(value >= mean for value in frame)


def detect_repeated_segments(path):
    result = run_process([
        "ffmpeg", "-v", "error", "-xerror", "-err_detect", "explode", "-i", str(path),
        "-map", "0:v:0", "-vf", "fps=2,scale=16:16:flags=area,format=gray",
        "-an", "-f", "rawvideo", "-",
    ], binary=True)
    size = 16 * 16
    frames = [_average_hash(result.stdout[offset:offset + size])
              for offset in range(0, len(result.stdout) - size + 1, size)]
    matches = []
    minimum = 4
    for first in range(len(frames) - minimum + 1):
        for second in range(first + minimum, len(frames) - minimum + 1):
            if frames[first:first + minimum] != frames[second:second + minimum]:
                continue
            length = minimum
            while (second + length < len(frames) and
                   frames[first + length] == frames[second + length]):
                length += 1
            item = {"first_start": first / 2, "first_end": (first + length) / 2,
                    "second_start": second / 2, "second_end": (second + length) / 2}
            if not any(item["first_start"] >= old["first_start"] and
                       item["first_end"] <= old["first_end"] and
                       item["second_start"] >= old["second_start"] and
                       item["second_end"] <= old["second_end"] for old in matches):
                matches.append(item)
            if len(matches) >= 20:
                return matches
    return matches


def detect_scene_changes(path):
    result = run_process([
        "ffmpeg", "-hide_banner", "-v", "info", "-xerror", "-err_detect", "explode",
        "-i", str(path), "-map", "0:v:0", "-vf", "select='gt(scene,0.35)',showinfo",
        "-an", "-f", "null", "-",
    ])
    return [float(value) for value in re.findall(r"pts_time:([0-9.]+)", result.stderr)]


def audio_volume(path):
    result = run_process([
        "ffmpeg", "-hide_banner", "-v", "info", "-xerror", "-err_detect", "explode",
        "-i", str(path), "-map", "0:a:0", "-vn", "-af", "volumedetect", "-f", "null", "-",
    ])
    def value(name):
        match = re.search(name + r"_volume:\s*(-?[0-9.]+|-inf)", result.stderr)
        if not match or match.group(1) == "-inf":
            return None
        return float(match.group(1))
    return {"mean_volume_db": value("mean"), "max_volume_db": value("max")}


def extract_review_frames(path, directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    for old in directory.glob("frame-*.jpg"):
        old.unlink()
    run_process([
        "ffmpeg", "-y", "-v", "error", "-i", str(path), "-map", "0:v:0",
        "-vf", "fps=2,scale=270:360:flags=lanczos", "-q:v", "4",
        str(directory / "frame-%04d.jpg"),
    ])
    return len(list(directory.glob("frame-*.jpg")))


def _empty_record(role, path):
    return {"role": role, "file": str(path), "checks": [], "hard_failures": [],
            "review": [], "analysis": {}}


def _metadata_timeline(metadata, expected_count):
    if not isinstance(metadata, dict) or not isinstance(metadata.get("shots"), list):
        return None, ["metadata.shots 不是有效数组"]
    shots = metadata["shots"]
    errors = []
    if len(shots) != expected_count:
        errors.append(f"场景数 metadata={len(shots)} plan={expected_count}")
    cursor = 0.0
    usable = bool(shots)
    for index, shot in enumerate(shots, 1):
        if not isinstance(shot, dict):
            errors.append(f"第 {index} 段 metadata 不是对象")
            usable = False
            continue
        try:
            start = float(shot["timeline_start"])
            end = float(shot["timeline_end"])
            source_duration = float(shot["source_duration"])
        except (KeyError, TypeError, ValueError) as exc:
            errors.append(f"第 {index} 段时间轴字段无效: {exc}")
            usable = False
            continue
        if not all(math.isfinite(value) for value in (start, end, source_duration)):
            errors.append(f"第 {index} 段时间轴不是有限数值")
            usable = False
            continue
        if abs(start - cursor) > 1e-6:
            errors.append(f"第 {index} 段起点 {start:.9f} 不连续，期望 {cursor:.9f}")
        if end <= start or source_duration <= 0:
            errors.append(f"第 {index} 段必须有正时长")
            usable = False
        if abs(end - start - source_duration) > 1e-6:
            errors.append(f"第 {index} 段 source_duration 与时间轴不一致")
        cursor = end
    if "timeline_duration" in metadata:
        try:
            declared = float(metadata["timeline_duration"])
            if not math.isfinite(declared) or abs(declared - cursor) > 1e-6:
                errors.append(f"timeline_duration={declared} 与逐段时间轴 {cursor:.9f} 不一致")
        except (TypeError, ValueError) as exc:
            errors.append(f"timeline_duration 无效: {exc}")
    return (cursor if usable and shots else None), errors


def _check_sentence_wavs(plan, final, shots, planned, check, record):
    results = []
    for index, expected in enumerate(planned, 1):
        shot = shots[index - 1]
        relative = shot.get("voice_file") or f"work/voice-processed/vo{index}-f.wav"
        path = final.parent / relative
        item = {"index": index, "file": str(path)}
        try:
            actual_hash = sha256_file(path)
            actual_duration = wav_dur(path)
            volume = audio_volume(path)
            expected_measured = float(shot["voice_duration_measured"])
            expected_source = float(shot["source_duration"])
            expected_hash = shot.get("voice_file_sha256")
            hash_ok = isinstance(expected_hash, str) and actual_hash == expected_hash
            timing_ok = (actual_duration > 0 and math.isfinite(expected_measured) and
                         abs(actual_duration - expected_measured) <= 1e-6)
            frame_ok = (math.isfinite(expected_source) and
                        abs(frame_duration(actual_duration, plan.fps) - expected_source) <= 1e-6)
            maximum = volume["max_volume_db"]
            non_silent = maximum is not None and maximum > -50.0
            item.update({
                "actual_sha256": actual_hash,
                "expected_sha256": expected_hash,
                "hash_ok": hash_ok,
                "actual_duration": actual_duration,
                "metadata_duration": expected_measured,
                "timing_ok": timing_ok,
                "frame_duration_ok": frame_ok,
                "max_volume_db": maximum,
                "non_silent": non_silent,
            })
            passed = hash_ok and timing_ok and frame_ok and non_silent
        except (MediaError, OSError, KeyError, TypeError, ValueError, wave.Error, EOFError) as exc:
            item["error"] = str(exc)
            passed = False
        results.append(item)
        check(f"sentence_wav_{index}", passed,
              json.dumps(item, ensure_ascii=False, sort_keys=True))
    record["analysis"]["sentence_wavs"] = results


def validate_one(plan, role, extract=False):
    final = plan.output_root / role / ("video-cover.mp4" if role == "cover" else "video-main.mp4")
    metadata_path = final.parent / "build-metadata.json"
    record = _empty_record(role, final)

    def check(name, passed, detail, hard=True):
        status = "pass" if passed else ("fail" if hard else "review")
        record["checks"].append({"name": name, "status": status, "hard": hard, "detail": detail})
        if hard and not passed:
            record["hard_failures"].append(f"{name}: {detail}")
        return passed

    if not final.is_file():
        check("output_exists", False, f"文件不存在: {final}")
        return record
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        check("build_metadata", False, f"无法读取 {metadata_path}: {exc}")
        metadata = None
    try:
        probe = probe_media(final, count_frames=True)
        stream = video_stream(probe)
        duration = video_duration(probe)
        container_duration = media_duration(probe)
        width = int(stream["width"])
        height = int(stream["height"])
        fps = stream_fps(stream)
        audios = audio_streams(probe)
    except (MediaError, KeyError, ValueError) as exc:
        check("ffprobe", False, str(exc))
        return record
    planned = plan.cover if role == "cover" else plan.main
    planned_duration, timeline_errors = _metadata_timeline(metadata, len(planned))
    audio_lengths = []
    audio_records = []
    for item in audios:
        try:
            length = audio_duration(item)
        except MediaError:
            length = None
        audio_lengths.append(length)
        audio_records.append({"codec": item.get("codec_name"), "profile": item.get("profile"),
                              "sample_rate": item.get("sample_rate"), "channels": item.get("channels"),
                              "duration": length})
    size = final.stat().st_size
    record["probe"] = {
        "duration": duration,
        "format_duration": container_duration,
        "video_frames": stream.get("nb_read_frames", stream.get("nb_frames")),
        "bytes": size,
        "width": width,
        "height": height,
        "long_edge": max(width, height),
        "codec": stream.get("codec_name"),
        "pixel_format": stream.get("pix_fmt"),
        "fps": fps,
        "faststart": faststart_status(final),
        "audio": audio_records,
    }
    video_tolerance = 1.0 / plan.fps + 1e-6
    record["analysis"]["timeline"] = {
        "metadata_duration": planned_duration,
        "video_duration": duration,
        "audio_durations": audio_lengths,
        "video_tolerance": video_tolerance,
        "aac_tolerance": AAC_TIMELINE_TOLERANCE,
        "errors": timeline_errors,
    }
    check("metadata_timeline", not timeline_errors,
          f"metadata={planned_duration}; errors={timeline_errors}")
    check("video_stream_timeline",
          planned_duration is not None and abs(duration - planned_duration) <= video_tolerance,
          f"video={duration:.6f}s metadata={planned_duration}s tolerance={video_tolerance:.6f}s")
    if role == "main":
        actual_audio = audio_lengths[0] if len(audio_lengths) == 1 else None
        check("audio_stream_timeline",
              planned_duration is not None and actual_audio is not None and
              abs(actual_audio - planned_duration) <= AAC_TIMELINE_TOLERANCE,
              f"audio={actual_audio}s metadata={planned_duration}s "
              f"AAC_tolerance={AAC_TIMELINE_TOLERANCE:.6f}s")
    check("duration_hard_range", 8.0 - 1e-6 <= duration <= 30.0 + 1e-6,
          f"video_actual={duration:.3f}s required=8–30s")
    target = (12.0, 15.0) if role == "cover" else (20.0, 26.0)
    check("duration_target", target[0] - 1e-6 <= duration <= target[1] + 1e-6,
          f"video_actual={duration:.3f}s target={target[0]:g}–{target[1]:g}s")
    check("byte_budget", size <= plan.spec["max_bytes"] and size <= 18_000_000,
          f"actual={size} internal_limit={min(plan.spec['max_bytes'], 18_000_000)}")
    check("dimensions", (width, height) == (plan.spec["width"], plan.spec["height"]),
          f"actual={width}x{height} expected={plan.spec['width']}x{plan.spec['height']}")
    check("long_edge_and_aspect", 1080 <= max(width, height) <= 1920 and width * 4 == height * 3,
          f"actual={width}x{height}, long_edge=1080–1920, aspect=3:4")
    check("h264", stream.get("codec_name") == "h264", f"actual={stream.get('codec_name')}")
    check("yuv420p", stream.get("pix_fmt") == "yuv420p", f"actual={stream.get('pix_fmt')}")
    check("fps", plan.fps in (24, 30) and abs(fps - plan.fps) <= 0.01,
          f"actual={fps:.6f} expected={plan.fps}")
    check("faststart", record["probe"]["faststart"], "moov 必须位于 mdat 之前")
    if role == "cover":
        check("cover_no_audio", len(audios) == 0, f"audio_streams={len(audios)}，封面优先且必须零音轨")
    else:
        valid_aac = _main_aac_valid(audios)
        check("main_aac_lc", valid_aac,
              f"audio={record['probe']['audio']}，正片需要一条 AAC-LC/48000Hz/双声道音轨")
        if valid_aac:
            try:
                volume = audio_volume(final)
                record["analysis"]["audio_volume"] = volume
                maximum = volume["max_volume_db"]
                check("main_non_silent", maximum is not None and maximum > -50.0,
                      f"max_volume={maximum}dB，阈值>-50dB")
            except MediaError as exc:
                check("main_non_silent", False, str(exc))
    try:
        strict_decode(final)
        check("full_decode", True, "全片音视频使用 -xerror/-err_detect=explode 严格解码无错误")
    except MediaError as exc:
        check("full_decode", False, str(exc))
    freezes = []
    try:
        freezes = detect_freezes(final, duration)
        record["analysis"]["freezes"] = freezes
        check("freezedetect", not freezes, f"events={freezes}")
    except MediaError as exc:
        check("freezedetect", False, str(exc))
    try:
        repeated = detect_repeated_segments(final)
        record["analysis"]["repeated_segments"] = repeated
        check("repeated_segments", not repeated, f"events={repeated}")
    except MediaError as exc:
        check("repeated_segments", False, str(exc))
    expected_boundaries = []
    if metadata and isinstance(metadata.get("shots"), list):
        expected_boundaries = [float(shot["timeline_end"]) for shot in metadata["shots"][:-1]
                               if "timeline_end" in shot]
    try:
        changes = detect_scene_changes(final)
        unexpected = [value for value in changes
                      if not any(abs(value - expected) <= 0.35 for expected in expected_boundaries)]
        record["analysis"]["scene_changes"] = {"all": changes, "expected_boundaries": expected_boundaries,
                                                "unexpected": unexpected}
        check("scene_changes", not unexpected,
              f"all={changes}; expected={expected_boundaries}; unexpected={unexpected}", hard=False)
        if unexpected:
            record["review"].append({"item": "unexpected_scene_changes", "status": "required",
                                     "detail": unexpected})
    except MediaError as exc:
        check("scene_changes", False, str(exc))
    if metadata is not None:
        shots = metadata.get("shots")
        check("metadata_scene_count", isinstance(shots, list) and len(shots) == len(planned),
              f"metadata={len(shots) if isinstance(shots, list) else 'invalid'} plan={len(planned)}")
        if role == "main" and isinstance(shots, list):
            counts_ok = len(shots) == len(planned) and all(isinstance(shot, dict) for shot in shots)
            tail_results = []
            for index, shot in enumerate(shots if counts_ok else []):
                expected = planned[index]
                same_copy = shot.get("voice") == expected["voice"] and shot.get("subtitles") == expected["subtitles"]
                if not same_copy:
                    check(f"sentence_copy_{index + 1}", False, "元数据中的配音/字幕与 plan 不一致")
                end = float(shot.get("timeline_end", 0))
                tail_start = max(float(shot.get("timeline_start", 0)), end - 0.35)
                overlapping = [event for event in freezes
                               if event["start"] < end and event["end"] > tail_start]
                tail_results.append({"index": index + 1, "tail_start": tail_start,
                                     "timeline_end": end, "freeze_overlap": overlapping})
            record["analysis"]["sentence_tails"] = tail_results
            check("sentence_tails", counts_ok and all(not item["freeze_overlap"] for item in tail_results),
                  f"tails={tail_results}")
            measured = [shot.get("voice_duration_measured") for shot in shots]
            check("measured_sentence_timings",
                  len(measured) == len(planned) and all(
                      isinstance(value, (int, float)) and not isinstance(value, bool) and
                      math.isfinite(value) and value > 0 for value in measured),
                  f"逐句实测时长={measured}；禁止估算或虚构词级时间")
            if counts_ok:
                _check_sentence_wavs(plan, final, shots, planned, check, record)
    if extract:
        try:
            count = extract_review_frames(final, plan.output_root / "qc" / role)
            record["analysis"]["review_frames"] = {"directory": str(plan.output_root / "qc" / role),
                                                    "fps": 2, "count": count}
        except MediaError as exc:
            record["review"].append({"item": "review_frame_extraction", "status": "failed", "detail": str(exc)})
    return record


def validate_plan(plan, extract=False):
    report = {
        "schema_version": 1,
        "sku": plan.sku,
        "auto": {role: validate_one(plan, role, extract=extract) for role in ("cover", "main")},
        "required_review": [
            {"media": "cover", "item": "mute_semantic_understanding", "status": "required",
             "detail": "人工/真实多模态确认静音时能理解是什么、结构、使用和购买前核对"},
            {"media": "cover", "item": "visual_truth_and_cleanliness", "status": "required",
             "detail": "核对真实商品、动作、数量、接口及无假文字/品牌/水印"},
            {"media": "main", "item": "russian_voice_subtitles_and_original_speed", "status": "required",
             "detail": "实际试听并核对俄语、字幕、原速和句意对应；自动非静音不等于语音合格"},
            {"media": "main", "item": "visual_truth_and_continuous_motion", "status": "required",
             "detail": "连续目检商品、场景、动作与句尾；自动检测不能替代语义验收"},
        ],
    }
    for role in ("cover", "main"):
        for item in report["auto"][role].get("review", []):
            report["required_review"].append({"media": role, **item})
    report["auto_ok"] = all(not report["auto"][role]["hard_failures"] for role in ("cover", "main"))
    report["status"] = "AUTO_PASS_REVIEW_REQUIRED" if report["auto_ok"] else "AUTO_FAIL"
    write_json(plan.output_root / "media-qc.json", report)
    return report


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print("用法: python validate_media.py <path/to/video-plan.json>", file=sys.stderr)
        return 2
    try:
        plan = load_plan(argv[0])
        report = validate_plan(plan, extract=True)
    except PipelineError as exc:
        print(f"MEDIA_QC_FAIL: {exc}", file=sys.stderr)
        return 1
    print(f"MEDIA_QC_REPORT: {plan.output_root / 'media-qc.json'}")
    print(report["status"])
    return 0 if report["auto_ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
