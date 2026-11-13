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
prompt_sha256 = hashlib.sha256(prompt_path.read_bytes()).hexdigest()
model = "gemini-4-carbon"
key = omni._load_key()
output_path.parent.mkdir(parents=True, exist_ok=True)
base = {
    "requestedModel": model,
    "actualModel": None,
    "requestedThinkingLevel": "HIGH",
    "actualThinkingLevel": None,
    "createdAt": datetime.now(timezone.utc).isoformat(),
    "promptFile": str(prompt_path),
    "promptSha256": prompt_sha256,
    "productionChanges": False,
}
try:
    response = omni._post_with_retry(
        f"{omni.API_BASE}/models/{model}:generateContent?key={key}",
        {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "thinkingConfig": {"thinkingLevel": "HIGH"},
                "responseMimeType": "application/json",
                "maxOutputTokens": 32768,
            },
        },
        timeout=300,
        retries=1,
    )
    if not response.ok:
        raise omni._http_error(response, (key,), "Gemini Carbon request failed")
    data = response.json()
    actual_model = data.get("modelVersion") or data.get("model")
    candidates = data.get("candidates") or []
    parts = candidates[0].get("content", {}).get("parts", []) if candidates else []
    text = "\n".join(part["text"] for part in parts if part.get("text") and not part.get("thought")).strip()
    received = {
        **base,
        "actualModel": actual_model,
        "status": "RESPONSE_RECEIVED",
        "rawContent": text,
        "usage": data.get("usageMetadata"),
        "finishReason": candidates[0].get("finishReason") if candidates else None,
    }
    output_path.write_text(json.dumps(received, ensure_ascii=False, indent=2), encoding="utf-8")
    if actual_model != model:
        raise RuntimeError(f"Unexpected actual model: {actual_model}")
    if not text:
        raise RuntimeError(f"Carbon returned no text: {json.dumps(data.get('promptFeedback'), ensure_ascii=False)[:400]}")
    try:
        plan = json.loads(text)
    except json.JSONDecodeError:
        fence = text.strip()
        if fence.startswith("```") and fence.endswith("```"):
            fence = fence.split("\n", 1)[1].rsplit("```", 1)[0]
            plan = json.loads(fence)
        else:
            raise
    if not isinstance(plan, dict):
        raise RuntimeError("Carbon plan must be a JSON object")
    result = {**received, "status": "SUCCESS", "plan": plan}
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"status": result["status"], "requestedModel": model, "actualModel": actual_model, "usage": result["usage"], "productionChanges": False}, ensure_ascii=False))
except Exception as exc:
    failure = {
        **base,
        "actualModel": locals().get("actual_model"),
        "status": "FAILED",
        "rawContent": locals().get("text", ""),
        "usage": locals().get("data", {}).get("usageMetadata"),
        "finishReason": (locals().get("data", {}).get("candidates") or [{}])[0].get("finishReason"),
        "error": omni._failure_text(exc, key, getattr(exc, "interaction_id", None)),
    }
    output_path.write_text(json.dumps(failure, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(failure, ensure_ascii=False))
    raise SystemExit(1)
