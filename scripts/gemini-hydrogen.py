import argparse
import hashlib
import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("omni", ROOT / "temp" / "omni-gen" / "omni_gen.py")
omni = importlib.util.module_from_spec(spec)
spec.loader.exec_module(omni)

MODEL = "gemini-4-hydrogen-high"


def _redact_receipt(value):
    if isinstance(value, dict):
        return {name: _redact_receipt(item) for name, item in value.items()}
    if isinstance(value, list):
        return [_redact_receipt(item) for item in value]
    if isinstance(value, str):
        return omni._redact(value, ())
    return value


def _write_receipt(output_path, receipt):
    output_path.write_text(json.dumps(_redact_receipt(receipt), ensure_ascii=False, indent=2), encoding="utf-8")


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt-file", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--image", action="append", default=[])
    args = parser.parse_args(argv)

    prompt_path = Path(args.prompt_file).resolve()
    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    augmented_path = output_path.parent / f"{output_path.stem}.prompt.txt"
    receipt = {
        "source": "Google Antigravity CLI",
        "requestedModel": MODEL,
        "actualModel": None,
        "requestedThinkingLevel": "HIGH",
        "actualThinkingLevel": None,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "promptFile": str(prompt_path),
        "antigravityPromptFile": str(augmented_path),
        "promptSha256": None,
        "productionChanges": False,
        "sandbox": True,
        "permissionMode": None,
        "status": "FAILED",
        "rawContent": "",
        "usage": None,
        "finishReason": None,
        "toolsUsed": [],
        "images": [],
    }
    evidence = {}
    try:
        prompt_bytes = prompt_path.read_bytes()
        prompt = prompt_bytes.decode("utf-8")
        receipt["promptSha256"] = hashlib.sha256(prompt_bytes).hexdigest()
        image_instructions = []
        for index, image_path in enumerate(args.image, 1):
            source = Path(image_path).resolve()
            media, metadata = omni._read_image_asset(source)
            receipt["images"].append({
                "path": str(source),
                "sha256": metadata["sha256"],
                "mime_type": metadata["mime_type"],
            })
            image_instructions.append(
                f"{index}. 使用 view_file 或 read_file 读取 {source}，按原提示检查该图，不得只根据文字猜测。"
            )
        augmented = prompt
        if image_instructions:
            augmented += (
                "\n\n视觉输入要求：以下图片必须实际调用 read_file 或 view_file 读取，"
                "不得根据提示文字或文件名推断内容。只读图片，不修改任何文件或生产数据。\n"
                + "\n".join(image_instructions)
            )
        augmented_path.write_text(augmented, encoding="utf-8")
        output_path.unlink(missing_ok=True)
        result = subprocess.run(
            [
                "node", str(ROOT / "scripts" / "antigravity-run.mjs"),
                "--prompt-file", str(augmented_path), "--output", str(output_path),
                "--model", MODEL, "--effort", "high", "--sandbox",
            ],
            cwd=ROOT, capture_output=True, text=True, timeout=900,
        )
        if output_path.is_file():
            evidence = json.loads(output_path.read_text(encoding="utf-8"))
        else:
            evidence = {}
        init = evidence.get("init") or {}
        model_result = evidence.get("result") or {}
        receipt.update({
            "actualModel": evidence.get("actualModel"),
            "permissionMode": init.get("permission_mode"),
            "rawContent": model_result.get("response") or "",
            "usage": model_result.get("usage"),
            "toolsUsed": evidence.get("toolsUsed") or [],
            "conversationId": model_result.get("conversation_id"),
            "stderr": evidence.get("stderr"),
        })
        if result.returncode != 0 or evidence.get("validationError"):
            raise RuntimeError(evidence.get("validationError") or f"Antigravity exited {result.returncode}")
        if receipt["actualModel"] != MODEL:
            raise RuntimeError(f"Unexpected actual model: {receipt['actualModel']}")
        if receipt["permissionMode"] != "request-review":
            raise RuntimeError(f"Unexpected permission mode: {receipt['permissionMode']}")
        if not receipt["rawContent"].strip():
            raise RuntimeError("Hydrogen returned no content")
        usage = receipt["usage"] or {}
        if not isinstance(usage.get("total_tokens"), (int, float)) or usage["total_tokens"] <= 0:
            raise RuntimeError("Hydrogen returned no valid token usage")
        if args.image and not any(name in ("read_file", "view_file") for name in receipt["toolsUsed"]):
            raise RuntimeError("Visual input was not read through read_file or view_file")
        receipt["status"] = "SUCCESS"
        receipt["finishReason"] = "STOP"
    except Exception as exc:
        receipt["status"] = "FAILED"
        receipt["error"] = omni._failure_text(exc, None, getattr(exc, "interaction_id", None))

    _write_receipt(output_path, receipt)
    print(json.dumps({
        "status": receipt["status"],
        "requestedModel": MODEL,
        "actualModel": receipt["actualModel"],
        "usage": receipt["usage"],
        "toolsUsed": receipt["toolsUsed"],
        "output": str(output_path),
    }, ensure_ascii=False))
    return 0 if receipt["status"] == "SUCCESS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
