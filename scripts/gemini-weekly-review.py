import argparse
import hashlib
import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("omni", ROOT / "temp" / "omni-gen" / "omni_gen.py")
omni = importlib.util.module_from_spec(spec)
spec.loader.exec_module(omni)

parser = argparse.ArgumentParser()
parser.add_argument("--prompt", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
prompt_path = Path(args.prompt).resolve()
output_path = Path(args.output).resolve()
prompt = prompt_path.read_text(encoding="utf-8")
key = omni._load_key()
body = {
    "contents": [{"role": "user", "parts": [{"text": prompt}]}],
    "generationConfig": {"thinkingConfig": {"thinkingLevel": "HIGH"}},
}
try:
    response = omni._post_with_retry(
        f"{omni.API_BASE}/models/gemini-4-argon:generateContent?key={key}",
        body,
        timeout=240,
        retries=1,
    )
    data = response.json()
    candidates = data.get("candidates") or []
    parts = candidates[0].get("content", {}).get("parts", []) if candidates else []
    text = "\n".join(part["text"] for part in parts if part.get("text")).strip()
    if not text:
        raise RuntimeError(f"Gemini returned no text: {json.dumps(data, ensure_ascii=False)[:400]}")
    result = {
        "model": "gemini-4-argon",
        "modelVersion": data.get("modelVersion"),
        "thinkingLevel": "HIGH",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "promptFile": str(prompt_path),
        "promptSha256": hashlib.sha256(prompt_path.read_bytes()).hexdigest(),
        "text": text,
        "thoughtsTokenCount": (data.get("usageMetadata") or {}).get("thoughtsTokenCount"),
        "usage": data.get("usageMetadata"),
        "productionChanges": False,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: result[key] for key in ("model", "modelVersion", "thinkingLevel", "thoughtsTokenCount", "productionChanges")}, ensure_ascii=False))
except Exception as exc:
    failure = {
        "model": "gemini-4-argon",
        "thinkingLevel": "HIGH",
        "status": "REVIEW_FAILED",
        "error": omni._failure_text(exc, key),
        "productionChanges": False,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(failure, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(failure, ensure_ascii=False))
    raise SystemExit(1)
