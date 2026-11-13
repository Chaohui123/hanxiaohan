import sys

from pipeline_errors import PipelineError
from plan_schema import load_plan
from validate_media import validate_plan


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print("用法: python qc_frames.py <path/to/video-plan.json>；旧 slug 入口已停用", file=sys.stderr)
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
