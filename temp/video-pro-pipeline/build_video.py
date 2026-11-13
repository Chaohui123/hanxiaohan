import sys
from pathlib import Path

from make_overlays import make_text_overlay
from media_common import (cache_valid, compose_timeline, encode_with_budget, frame_duration,
                          pipeline_fingerprint, probe_media, render_video_shot, sha256_file,
                          video_duration, write_json)
from pipeline_errors import MediaError, PipelineError
from plan_schema import load_plan
import process_vo


SOURCES = ("build_video.py", "media_common.py", "make_overlays.py", "plan_schema.py",
           "make_vo_yandex.py", "process_vo.py")


def build_main(plan, voice_generator=None):
    directory = plan.output_root / "main"
    work = directory / "work"
    final = directory / "video-main.mp4"
    metadata_path = directory / "build-metadata.json"
    manifest_path = directory / "build-manifest.json"
    fingerprint = pipeline_fingerprint(plan, "main", SOURCES)
    if cache_valid(final, metadata_path, manifest_path, fingerprint):
        return final
    work.mkdir(parents=True, exist_ok=True)
    texts = [shot["voice"] for shot in plan.main]
    if voice_generator is None:
        from make_vo_yandex import generate_sentences
        voice_generator = generate_sentences
    sources = voice_generator(texts, work / "voice-source", plan.voice)
    if not isinstance(sources, (list, tuple)) or len(sources) != len(plan.main):
        raise MediaError(f"场景与音频数量不一致: scenes={len(plan.main)} audio={len(sources) if isinstance(sources, (list, tuple)) else 'invalid'}")
    processed = process_vo.process_audio_files(sources, work / "voice-processed")
    if len(processed) != len(plan.main):
        raise MediaError("场景与修剪后音频数量不一致")
    voice_durations = [process_vo.wav_dur(path) for path in processed]
    durations = [frame_duration(duration, plan.fps) for duration in voice_durations]
    voice_total = sum(voice_durations)
    timeline_total = sum(durations)
    if voice_total > 30.0 or timeline_total > 30.0:
        raise MediaError(f"正常视频超过 30 秒（voice={voice_total:.3f}s timeline={timeline_total:.3f}s），请改短文案；禁止变速或静态补时")
    if not 20.0 <= timeline_total <= 26.0:
        raise MediaError(f"正常视频目标总时长必须为 20–26 秒，当前 {timeline_total:.3f}s；请按真实句长增删文案与镜头")
    intervals = {}
    for index, (shot, duration) in enumerate(zip(plan.main, durations), 1):
        clip = plan.clips[shot["clip"]]
        start = shot["start"]
        end = start + duration
        for old_start, old_end, old_index in intervals.get(shot["clip"], []):
            if start < old_end - 1e-9 and old_start < end - 1e-9:
                raise MediaError(
                    f"第 {old_index} 句与第 {index} 句按真实配音句长使用同一素材时区间重叠: "
                    f"{clip.clip_id} [{start:.3f},{end:.3f}) 与 [{old_start:.3f},{old_end:.3f})"
                )
        intervals.setdefault(shot["clip"], []).append((start, end, index))
        if end > clip.duration + 1e-6:
            raise MediaError(
                f"第 {index} 句需要 {duration:.3f}s，素材 {clip.clip_id} 剩余不足（画面）；"
                "请补真实连续镜头，禁止 setpts 慢放、循环或定格补时"
            )
    segments = []
    shot_metadata = []
    timeline = 0.0
    for index, (shot, duration, voice_duration, audio) in enumerate(
            zip(plan.main, durations, voice_durations, processed), 1):
        overlay = make_text_overlay(shot["subtitles"], work / f"subtitle-{index}.png",
                                    plan.spec["width"], plan.spec["height"], "main",
                                    plan.spec["font_path"])
        segment = work / f"segment-{index}.mp4"
        render_video_shot(plan.clips[shot["clip"]], shot["start"], duration,
                          overlay["path"], segment, plan.spec, plan.fps)
        segments.append(segment)
        end = timeline + duration
        shot_metadata.append({
            "index": index,
            "clip": shot["clip"],
            "source_start": shot["start"],
            "source_duration": duration,
            "timeline_start": timeline,
            "timeline_end": end,
            "voice": shot["voice"],
            "subtitles": shot["subtitles"],
            "subtitle_lines": overlay["lines"],
            "voice_duration_measured": voice_duration,
            "voice_timing_source": "trimmed WAV frame count / sample rate",
            "voice_file": f"work/voice-processed/{audio.name}",
            "voice_file_sha256": sha256_file(audio),
            "source_audio_sha256": sha256_file(sources[index - 1]),
        })
        timeline = end
    if not len(segments) == len(processed) == len(shot_metadata) == len(plan.main):
        raise MediaError("正片场景/字幕/音频数量不一致")
    master = work / "main-master.mp4"
    compose_timeline(segments, master, plan.spec, plan.fps,
                     audio_paths=processed, audio_durations=durations)
    encoding = encode_with_budget(master, final, plan.spec, has_audio=True)
    final_duration = video_duration(probe_media(final, count_frames=True))
    metadata = {
        "schema_version": 1,
        "role": "main",
        "sku": plan.sku,
        "fps": plan.fps,
        "width": plan.spec["width"],
        "height": plan.spec["height"],
        "duration": final_duration,
        "timeline_duration": timeline_total,
        "timing_source": "measured trimmed SpeechKit WAV audio; video durations rounded up to whole source frames",
        "voice_config": plan.voice,
        "voice_duration_total": voice_total,
        "shots": shot_metadata,
        "encoding": encoding,
    }
    write_json(metadata_path, metadata)
    write_json(manifest_path, {
        "schema_version": 1,
        "role": "main",
        "input_sha256": fingerprint,
        "output_sha256": sha256_file(final),
        "output": final.name,
    })
    return final


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print("用法: python build_video.py <path/to/video-plan.json>；旧 slug/GLM 入口已停用", file=sys.stderr)
        return 2
    try:
        result = build_main(load_plan(argv[0]))
    except PipelineError as exc:
        print(f"MAIN_FAIL: {exc}", file=sys.stderr)
        return 1
    print(f"MAIN_BUILT: {result}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
