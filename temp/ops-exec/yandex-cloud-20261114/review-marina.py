import base64
import hashlib
import importlib.util
import json
import re
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "temp" / "ops-exec" / "yandex-cloud-20261114"
spec = importlib.util.spec_from_file_location("omni", ROOT / "temp" / "omni-gen" / "omni_gen.py")
omni = importlib.util.module_from_spec(spec)
spec.loader.exec_module(omni)
text = "Проверка русской речи. Этот товар поможет вам подготовиться к зимнему сезону."
audio_path = OUT / "pipeline-voice" / "vo1.wav"
inputs = [{
    "type": "text",
    "text": (
        "你是俄语母语级音频质检员。请实际听取这段俄语电商配音，检查重音、词形、自然度、清晰度、句意完整性和是否像原速。"
        "不要只根据文本判断，不要输出音频token或模拟思考过程，只输出JSON。"
        "原文：" + text +
        "。格式：{\"verdict\":\"PASS|REVISE\",\"confidence\":\"高|中|低\",\"score\":1到100,"
        "\"issues\":[{\"word\":\"具体词\",\"issue\":\"具体问题\"}],\"reason\":\"中文简短结论\"}。"
        "没有确切问题的项目留空，不确定就明确写，不能编造转写。"
    ),
}, {"type": "text", "text": "待评音频："}, {
    "type": "audio", "data": base64.b64encode(audio_path.read_bytes()).decode("ascii"), "mime_type": "audio/wav",
}]
key = omni._load_key()
try:
    response = omni._post_with_retry(
        f"{omni.API_BASE}/interactions?key={key}",
        {"model": "gemini-4-argon", "input": inputs},
        timeout=240,
        retries=1,
    )
    if not response.ok:
        raise omni._http_error(response, (key,), "Yandex Marina blind audio review failed")
    payload = omni._await_interaction(response.json(), key, "text")
    chunks = []
    for step in payload.get("steps", []) or []:
        content = step.get("content", []) or []
        if isinstance(content, dict):
            content = [content]
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text" and item.get("text"):
                chunks.append(item["text"])
    raw_text = "\n".join(chunks).strip()
    match = re.search(r"\{[\s\S]*\}", raw_text)
    if not match:
        raise RuntimeError("audio review did not return JSON")
    verdict = json.loads(match.group(0))
    if verdict.get("verdict") not in ("PASS", "REVISE") or not isinstance(verdict.get("score"), (int, float)):
        raise RuntimeError("invalid audio review verdict")
    result = {
        "model": "gemini-4-argon",
        "method": "actual_wav_audio_input_provider_hidden_blind_review",
        "source_text": text,
        "review": raw_text,
        "verdict": verdict,
        "usage": omni._usage(payload),
        "audio_sha256": hashlib.sha256(audio_path.read_bytes()).hexdigest(),
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "production_changes": False,
    }
    (OUT / "marina-blind-review.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
except Exception as exc:
    failure = {
        "model": "gemini-4-argon",
        "status": "REVIEW_FAILED_NOT_APPROVED",
        "error": omni._failure_text(exc, key, getattr(exc, "interaction_id", None)),
        "production_changes": False,
    }
    (OUT / "marina-blind-review-error.json").write_text(json.dumps(failure, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(failure, ensure_ascii=False, indent=2))
    raise SystemExit(1)
