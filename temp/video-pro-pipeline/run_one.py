import sys

from build_cover import build_cover
from build_video import build_main
from pipeline_errors import MediaQCError, PipelineError
from plan_schema import load_plan
from validate_media import validate_plan


def run_plan(plan_path, voice_generator=None, extract=True):
    plan = load_plan(plan_path)
    build_cover(plan)
    build_main(plan, voice_generator=voice_generator)
    report = validate_plan(plan, extract=extract)
    if not report["auto_ok"]:
        failures = {role: report["auto"][role]["hard_failures"] for role in ("cover", "main")}
        raise MediaQCError(f"双视频自动硬指标失败: {failures}")
    return report


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print("用法: python run_one.py <path/to/video-plan.json>；旧 slug/GLM 多入口已停用", file=sys.stderr)
        return 2
    try:
        report = run_plan(argv[0])
    except PipelineError as exc:
        print(f"PIPELINE_FAIL: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"PIPELINE_FAIL: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    print("PIPELINE_AUTO_PASS_REVIEW_REQUIRED")
    print(f"MEDIA_QC: {report['auto']['cover']['file']} / {report['auto']['main']['file']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
