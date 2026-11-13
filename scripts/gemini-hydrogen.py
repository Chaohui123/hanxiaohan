import argparse
import hashlib
import importlib.util
import json
import os
from datetime import datetime, timezone
from pathlib import Path

os.environ.setdefault("HTTPS_PROXY", "http://127.0.0.1:10808")
os.environ.setdefault("HTTP_PROXY", "http://127.0.0.1:10808")
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("omni", ROOT / "temp" / "omni-gen" / "omni_gen.py")
omni = importlib.util.module_from_spec(spec)
spec.loader.exec_module(omni)

MODEL = "gemini-4-hydrogen"


def _redact_receipt(value, key):
    if isinstance(value, dict):
        return {name: _redact_receipt(item, key) for name, item in value.items()}
    if isinstance(value, list):
        return [_redact_receipt(item, key) for item in value]
    if isinstance(value, str):
        return omni._redact(value, (key,) if key else ())
    return value


def _write_receipt(output_path, receipt, key):
    clean = _redact_receipt(receipt, key)
    output_path.write_text(json.dumps(clean, ensure_ascii=False, indent=2), encoding="utf-8")


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt-file", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--image", action="append", default=[])
    args = parser.parse_args(argv)

    prompt_path = Path(args.prompt_file).resolve()
    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    key = None
    receipt = {
        "requestedModel": MODEL,
        "actualModel": None,
        "requestedThinkingLevel": "HIGH",
        "actualThinkingLevel": None,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "promptFile": str(prompt_path),
        "promptSha256": None,
        "productionChanges": False,
        "status": "FAILED",
        "rawContent": "",
        "usage": None,
        "finishReason": None,
        "images": [],
    }
    try:
        prompt_bytes = prompt_path.read_bytes()
        prompt = prompt_bytes.decode("utf-8")
        receipt["promptSha256"] = hashlib.sha256(prompt_bytes).hexdigest()

        image_parts = []
        for image_path in args.image:
            source = Path(image_path).resolve()
            media, metadata = omni._read_image_asset(source)
            image_parts.append({
                "inline_data": {
                    "data": media["data"],
                    "mime_type": media["mime_type"],
                }
            })
            receipt["images"].append({
                "path": str(source),
                "sha256": metadata["sha256"],
                "mime_type": metadata["mime_type"],
            })

        key = omni._load_key()
        response = omni._post_with_retry(
            f"{omni.API_BASE}/models/{MODEL}:generateContent?key={key}",
            {
                "contents": [{"role": "user", "parts": [{"text": prompt}, *image_parts]}],
                "generationConfig": {
                    "thinkingConfig": {"thinkingLevel": "HIGH"},
                    "maxOutputTokens": 32768,
                },
            },
            timeout=300,
            retries=1,
        )
        if not response.ok:
            raise omni._http_error(response, (key,), "Gemini Hydrogen request failed")

        data = response.json()
        actual_model = data.get("modelVersion") or data.get("model")
        candidates = data.get("candidates") or []
        candidate = candidates[0] if candidates else {}
        content = candidate.get("content") or {}
        parts = content.get("parts") or []
        text = "\n".join(
            part["text"]
            for part in parts
            if isinstance(part, dict) and part.get("text") and not part.get("thought")
        ).strip()
        receipt.update({
            "actualModel": actual_model,
            "rawContent": text,
            "usage": data.get("usageMetadata"),
            "finishReason": candidate.get("finishReason"),
        })
        if actual_model != MODEL:
            raise RuntimeError(f"Unexpected actual model: {actual_model}")
        if receipt["finishReason"] != "STOP":
            raise RuntimeError(f"Hydrogen finishReason must be STOP, got {receipt['finishReason']}")
        if not text:
            raise RuntimeError("Hydrogen returned no non-thought text")
        receipt["status"] = "SUCCESS"
    except Exception as exc:
        receipt["status"] = "FAILED"
        receipt["error"] = omni._failure_text(exc, key, getattr(exc, "interaction_id", None))

    _write_receipt(output_path, receipt, key)
    print(json.dumps({
        "status": receipt["status"],
        "requestedModel": MODEL,
        "actualModel": receipt["actualModel"],
        "usage": receipt["usage"],
        "output": str(output_path),
    }, ensure_ascii=False))
    return 0 if receipt["status"] == "SUCCESS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
