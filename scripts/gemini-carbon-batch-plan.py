import argparse
import hashlib
import importlib.util
import json
import re
import sys
import time
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
parser.add_argument("--operation", help="Resume polling without creating another batch")
args = parser.parse_args()
prompt_path = Path(args.prompt).resolve()
output_path = Path(args.output).resolve()
prompt_sha256 = hashlib.sha256(prompt_path.read_bytes()).hexdigest()
prompt = prompt_path.read_text(encoding="utf-8")
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
    "mode": "batchGenerateContent",
    "productionChanges": False,
}
operation_name = args.operation
operation = None
history = []
if operation_name and output_path.exists():
    previous = json.loads(output_path.read_text(encoding="utf-8"))
    if previous.get("operationName") != operation_name or previous.get("promptSha256") != prompt_sha256:
        raise RuntimeError("Operation and prompt must match the existing evidence file")
if operation_name and (not re.fullmatch(r"[A-Za-z0-9_./-]+", operation_name) or ".." in operation_name):
    raise ValueError("Invalid operation name")


def save(value):
    output_path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


try:
    if operation_name is None:
        response = omni._post_with_retry(
            f"{omni.API_BASE}/models/{model}:batchGenerateContent?key={key}",
            {
                "batch": {
                    "model": f"models/{model}",
                    "displayName": "onzo-direct-carbon-plan-20261111",
                    "inputConfig": {
                        "requests": {
                            "requests": [{
                                "metadata": {"key": "onzo-direct-plan"},
                                "request": {
                                    "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                                    "generationConfig": {
                                        "thinkingConfig": {"thinkingLevel": "HIGH"},
                                        "responseMimeType": "application/json",
                                        "maxOutputTokens": 32768,
                                    },
                                },
                            }],
                        },
                    },
                },
            },
            timeout=60,
            retries=1,
        )
        if not response.ok:
            raise omni._http_error(response, (key,), "Carbon batch creation failed")
        operation = response.json()
        operation_name = operation.get("name")
        if not operation_name:
            raise RuntimeError(f"Carbon batch has no operation name: {omni._redact(json.dumps(operation), (key,))[:400]}")
        save({**base, "status": "PENDING", "operationName": operation_name, "operationCreated": operation})
        print(json.dumps({"status": "PENDING", "operationName": operation_name, "requestedModel": model}, ensure_ascii=False), flush=True)
    deadline = time.monotonic() + 20 * 60
    while True:
        response = omni._get_with_retry(f"{omni.API_BASE}/{operation_name}?key={key}", timeout=60, retries=2)
        if not response.ok:
            raise omni._http_error(response, (key,), "Carbon batch polling failed")
        operation = response.json()
        history.append({"at": datetime.now(timezone.utc).isoformat(), "done": operation.get("done") is True})
        if operation.get("done"):
            break
        if time.monotonic() >= deadline:
            save({**base, "status": "PENDING", "operationName": operation_name, "pollingHistory": history, "note": "超时只代表本轮停止轮询，可用--operation继续，不重新创建batch"})
            print(json.dumps({"status": "PENDING", "operationName": operation_name}, ensure_ascii=False))
            raise SystemExit(2)
        time.sleep(15)
    if operation.get("error"):
        raise RuntimeError(f"Carbon batch failed: {json.dumps(operation['error'], ensure_ascii=False)[:500]}")
    batch = operation.get("response") or {}
    output = batch.get("output") or batch.get("batch", {}).get("output") or operation.get("output") or {}
    inlined = output.get("inlinedResponses") or batch.get("inlinedResponses") or operation.get("inlinedResponses") or {}
    rows = inlined.get("inlinedResponses") or inlined.get("responses") or []
    if not rows:
        raise RuntimeError(f"Carbon batch has no inline response: {json.dumps(output, ensure_ascii=False)[:500]}")
    row = rows[0]
    if row.get("error"):
        raise RuntimeError(f"Carbon batch item failed: {json.dumps(row['error'], ensure_ascii=False)[:500]}")
    data = row.get("response") or {}
    actual_model = data.get("modelVersion") or data.get("model")
    candidates = data.get("candidates") or []
    parts = candidates[0].get("content", {}).get("parts", []) if candidates else []
    text = "\n".join(part["text"] for part in parts if part.get("text") and not part.get("thought")).strip()
    received = {
        **base,
        "actualModel": actual_model,
        "status": "RESPONSE_RECEIVED",
        "operationName": operation_name,
        "batchName": batch.get("name"),
        "batchState": batch.get("state"),
        "batchStats": batch.get("batchStats"),
        "batchCreateTime": batch.get("createTime"),
        "batchEndTime": batch.get("endTime"),
        "pollingHistory": history,
        "rawContent": text,
        "usage": data.get("usageMetadata"),
        "finishReason": candidates[0].get("finishReason") if candidates else None,
    }
    save(received)
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
    save(result)
    print(json.dumps({"status": "SUCCESS", "requestedModel": model, "actualModel": actual_model, "operationName": operation_name, "usage": result["usage"], "productionChanges": False}, ensure_ascii=False))
except SystemExit:
    raise
except Exception as exc:
    done = bool(operation and operation.get("done"))
    failure = {
        **base,
        "actualModel": locals().get("actual_model"),
        "status": "FAILED" if done or not operation_name else "PENDING",
        "operationName": operation_name,
        "rawContent": locals().get("text", ""),
        "usage": locals().get("data", {}).get("usageMetadata"),
        "finishReason": (locals().get("data", {}).get("candidates") or [{}])[0].get("finishReason"),
        "pollingHistory": history,
        "error": omni._failure_text(exc, key, getattr(exc, "interaction_id", None)),
        "resumeWithoutNewBatch": f"--operation {operation_name}" if operation_name and not done else None,
    }
    save(failure)
    print(json.dumps(failure, ensure_ascii=False))
    raise SystemExit(1)
