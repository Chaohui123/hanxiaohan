import sys
from pathlib import Path

from make_overlays import make_text_overlay
from media_common import (cache_valid, compose_timeline, encode_with_budget, pipeline_fingerprint,
                          probe_media, render_video_shot, sha256_file, video_duration, write_json)
from pipeline_errors import MediaError, PipelineError
from plan_schema import load_plan


SOURCES = ("build_cover.py", "media_common.py", "make_overlays.py", "plan_schema.py")


def build_cover(plan):
    directory = plan.output_root / "cover"
    work = directory / "work"
    final = directory / "video-cover.mp4"
    metadata_path = directory / "build-metadata.json"
    manifest_path = directory / "build-manifest.json"
    fingerprint = pipeline_fingerprint(plan, "cover", SOURCES)
    if cache_valid(final, metadata_path, manifest_path, fingerprint):
        return final
    work.mkdir(parents=True, exist_ok=True)
    segments = []
    shot_metadata = []
    timeline = 0.0
    for index, shot in enumerate(plan.cover, 1):
        overlay = make_text_overlay(shot["label"], work / f"label-{index}.png",
                                    plan.spec["width"], plan.spec["height"], "cover",
                                    plan.spec["font_path"])
        segment = work / f"segment-{index}.mp4"
        render_video_shot(plan.clips[shot["clip"]], shot["start"], shot["duration"],
                          overlay["path"], segment, plan.spec, plan.fps)
        segments.append(segment)
        end = timeline + shot["duration"]
        shot_metadata.append({
            "index": index,
            "purpose": shot["purpose"],
            "clip": shot["clip"],
            "source_start": shot["start"],
            "source_duration": shot["duration"],
            "timeline_start": timeline,
            "timeline_end": end,
            "label": shot["label"],
            "label_lines": overlay["lines"],
        })
        timeline = end
    if len(segments) != len(shot_metadata) or len(segments) != len(plan.cover):
        raise MediaError("封面场景/标签/片段数量不一致")
    master = work / "cover-master.mp4"
    compose_timeline(segments, master, plan.spec, plan.fps)
    encoding = encode_with_budget(master, final, plan.spec, has_audio=False)
    final_duration = video_duration(probe_media(final, count_frames=True))
    metadata = {
        "schema_version": 1,
        "role": "cover",
        "sku": plan.sku,
        "fps": plan.fps,
        "width": plan.spec["width"],
        "height": plan.spec["height"],
        "duration": final_duration,
        "timeline_duration": timeline,
        "timing_source": "plan frame-aligned continuous source clips",
        "shots": shot_metadata,
        "encoding": encoding,
    }
    write_json(metadata_path, metadata)
    write_json(manifest_path, {
        "schema_version": 1,
        "role": "cover",
        "input_sha256": fingerprint,
        "output_sha256": sha256_file(final),
        "output": final.name,
    })
    return final


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print("用法: python build_cover.py <path/to/video-plan.json>", file=sys.stderr)
        return 2
    try:
        result = build_cover(load_plan(argv[0]))
    except PipelineError as exc:
        print(f"COVER_FAIL: {exc}", file=sys.stderr)
        return 1
    print(f"COVER_BUILT: {result}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
