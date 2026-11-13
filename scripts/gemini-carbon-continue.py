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
parser.add_argument("--operation-file", default="temp/direct-carbon-20261111/carbon-operation.json")
parser.add_argument("--output", required=True)
parser.add_argument("--resume-state")
args = parser.parse_args()
prompt_path = Path(args.prompt).resolve()
prompt = prompt_path.read_text(encoding="utf-8")
prompt_sha256 = hashlib.sha256(prompt_path.read_bytes()).hexdigest()
output_path = Path(args.output).resolve()
output_path.parent.mkdir(parents=True, exist_ok=True)
key = omni._load_key()
model = "gemini-4-carbon"
state_path = output_path.with_name("continuation-state.json")
chunks = []
history = []
if args.resume_state:
    state = Path(args.resume_state).read_text(encoding="utf-8")
    saved = json.loads(state)
    if saved.get("promptSha256") != prompt_sha256 or saved.get("requestedModel") != model:
        raise RuntimeError("Resume state must match prompt and Carbon model")
    token = saved.get("nextContinuationToken")
    chunks = saved.get("chunks") or []
    history = saved.get("history") or []
    source_operation = saved.get("sourceOperation")
else:
    operation = json.loads(Path(args.operation_file).read_text(encoding="utf-8"))
    source_operation = operation.get("name")
    response = operation.get("response") or {}
    output = response.get("output") or response
    rows = (output.get("inlinedResponses") or {}).get("inlinedResponses") or []
    if not rows:
        raise RuntimeError("Source operation has no inline response")
    data = rows[0].get("response") or {}
    candidate = (data.get("candidates") or [{}])[0]
    token = candidate.get("continuationToken")
    source_finish = candidate.get("finishReason")
    history.append({"sourceOperation": source_operation, "finishReason": source_finish, "usage": data.get("usageMetadata"), "note": "源响应为空且MAX_TOKENS；按官方continuationToken字段续写，未重新推理"})
if not token:
    raise RuntimeError("No continuation token available; do not create a new generation implicitly")
created_at = datetime.now(timezone.utc).isoformat()
initial_budget = (saved.get("nextMaxOutputTokens") or 65536) if args.resume_state else 49152
for index in range(3):
    max_output_tokens = initial_budget + index * 16384
    request = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"thinkingConfig": {"thinkingLevel": "HIGH"}, "responseMimeType": "application/json", "maxOutputTokens": max_output_tokens},
        "continuationToken": token,
    }
    try:
        response = omni._post_with_retry(
            f"{omni.API_BASE}/models/{model}:generateContent?key={key}",
            request,
            timeout=300,
            retries=1,
        )
        if not response.ok:
            raise omni._http_error(response, (key,), "Carbon continuation failed")
        data = response.json()
        actual_model = data.get("modelVersion") or data.get("model")
        candidates = data.get("candidates") or []
        candidate = candidates[0] if candidates else {}
        parts = candidate.get("content", {}).get("parts", [])
        text = "".join(part["text"] for part in parts if part.get("text") and not part.get("thought"))
        finish_reason = candidate.get("finishReason")
        next_token = candidate.get("continuationToken")
        history.append({"chunk": len(chunks) + 1, "actualModel": actual_model, "finishReason": finish_reason, "maxOutputTokens": max_output_tokens, "usage": data.get("usageMetadata"), "continuationTokenSha256": hashlib.sha256(token.encode()).hexdigest()})
        if actual_model != model:
            raise RuntimeError(f"Unexpected continuation model: {actual_model}")
        if text:
            chunks.append(text)
        state = {
            "requestedModel": model,
            "promptSha256": prompt_sha256,
            "sourceOperation": source_operation,
            "nextContinuationToken": next_token,
            "nextMaxOutputTokens": max_output_tokens + 16384 if next_token else None,
            "chunks": chunks,
            "history": history,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }
        state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        if not next_token or finish_reason not in {"MAX_TOKENS", "CONTINUATION"}:
            token = None
            break
        token = next_token
    except Exception as exc:
        failure = {
            "requestedModel": model,
            "actualModel": locals().get("actual_model"),
            "status": "CONTINUATION_FAILED",
            "sourceOperation": source_operation,
            "createdAt": created_at,
            "promptSha256": prompt_sha256,
            "rawContent": "".join(chunks),
            "history": history,
            "error": omni._failure_text(exc, key, getattr(exc, "interaction_id", None)),
            "resumeState": str(state_path) if state_path.exists() else None,
            "productionChanges": False,
        }
        output_path.write_text(json.dumps(failure, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(failure, ensure_ascii=False))
        raise SystemExit(1)
raw_content = "".join(chunks)
base = {
    "requestedModel": model,
    "actualModel": actual_model if "actual_model" in locals() else None,
    "requestedThinkingLevel": "HIGH",
    "actualThinkingLevel": None,
    "mode": "generateContent continuation",
    "sourceOperation": source_operation,
    "createdAt": created_at,
    "promptFile": str(prompt_path),
    "promptSha256": prompt_sha256,
    "rawContent": raw_content,
    "history": history,
    "productionChanges": False,
}
if not raw_content.strip():
    result = {**base, "status": "PENDING_CONTINUATION" if token else "FAILED", "error": "Continuation returned no final text", "resumeState": str(state_path) if token else None}
elif not token:
    try:
        plan = json.loads(raw_content)
        if not isinstance(plan, dict):
            raise RuntimeError("Continued plan is not an object")
        result = {**base, "status": "SUCCESS", "plan": plan}
    except Exception as exc:
        result = {**base, "status": "FAILED", "error": omni._failure_text(exc, key, None)}
else:
    result = {**base, "status": "PENDING_CONTINUATION", "resumeState": str(state_path), "error": "Additional continuation required; do not create a new generation"}
output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"status": result["status"], "requestedModel": model, "actualModel": result["actualModel"], "chunks": len(chunks), "rawContentLength": len(raw_content), "history": history, "productionChanges": False}, ensure_ascii=False))
if result["status"] != "SUCCESS":
    raise SystemExit(1)
