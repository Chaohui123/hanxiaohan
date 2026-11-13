import argparse
import importlib.util
import json
import os
from pathlib import Path

os.environ.setdefault("HTTPS_PROXY", "http://127.0.0.1:10808")
os.environ.setdefault("HTTP_PROXY", "http://127.0.0.1:10808")
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("omni", ROOT / "temp" / "omni-gen" / "omni_gen.py")
omni = importlib.util.module_from_spec(spec)
spec.loader.exec_module(omni)
parser = argparse.ArgumentParser()
parser.add_argument("--prompt-file", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
prompt = Path(args.prompt_file).read_text(encoding="utf-8")
key = omni._load_key()
try:
    response = omni._post_with_retry(
        f"{omni.API_BASE}/interactions?key={key}",
        {"model": "gemini-4-argon", "input": [{"type": "text", "text": prompt}]},
        timeout=300,
        retries=1,
    )
    if not response.ok:
        raise omni._http_error(response, (key,), "Argon weekly review failed")
    response.encoding = "utf-8"
    original_get = omni._get_with_retry
    def get_utf8(*args, **kwargs):
        polled = original_get(*args, **kwargs)
        polled.encoding = "utf-8"
        return polled
    omni._get_with_retry = get_utf8
    payload = omni._await_interaction(response.json(), key, "text")
    chunks = []
    for step in payload.get("steps", []) or []:
        content = step.get("content", []) or []
        if isinstance(content, dict):
            content = [content]
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text" and item.get("text"):
                chunks.append(item["text"])
    text = "\n".join(chunks).strip()
    if not text:
        raise RuntimeError("Argon returned no text")
    result = {
        "requestedModel": "gemini-4-argon",
        "actualModel": payload.get("model") or payload.get("model_name"),
        "requestedEffort": "HIGH",
        "actualEffort": None,
        "status": "SUCCESS",
        "review": text,
        "usage": omni._usage(payload),
        "productionChanges": False,
    }
except Exception as exc:
    result = {
        "requestedModel": "gemini-4-argon",
        "actualModel": None,
        "requestedEffort": "HIGH",
        "actualEffort": None,
        "status": "FAILED",
        "error": omni._failure_text(exc, key, getattr(exc, "interaction_id", None)),
        "productionChanges": False,
    }
Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"status": result["status"], "actualModel": result.get("actualModel"), "output": args.output}, ensure_ascii=False))
if result["status"] != "SUCCESS":
    raise SystemExit(1)
