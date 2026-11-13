import json
from pathlib import Path
import sys

sys.stdout.reconfigure(encoding="utf-8")

from offline_fixtures import OfflineVoiceFactory, create_fixture_plan
from run_one import run_plan


def main():
    directory = Path(__file__).resolve().parent / "test-out"
    plan_path = create_fixture_plan(directory)
    report = run_plan(plan_path, voice_generator=OfflineVoiceFactory(), extract=True)
    summary = {
        "plan": str(plan_path),
        "status": report["status"],
        "cover": report["auto"]["cover"]["probe"],
        "main": report["auto"]["main"]["probe"],
        "note": "技术样片使用几何运动素材与非静音 WAV 假配音；未做商品、俄语语音或静音语义验收",
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
