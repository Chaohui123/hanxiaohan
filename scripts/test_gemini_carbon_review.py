import hashlib
import importlib.util
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().with_name("gemini-carbon-review.py")
spec = importlib.util.spec_from_file_location("gemini_carbon_review", SCRIPT)
carbon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(carbon)

TEST_KEY = "offline-carbon-test-key"


class FakeResponse:
    def __init__(self, payload=None, ok=True, status_code=200, text=""):
        self.payload = payload
        self.ok = ok
        self.status_code = status_code
        self.text = text

    def json(self):
        return self.payload


def response_payload(model=carbon.MODEL, finish_reason="STOP", parts=None):
    if parts is None:
        parts = [{"text": "Carbon offline review"}]
    return {
        "modelVersion": model,
        "candidates": [{
            "content": {"parts": parts},
            "finishReason": finish_reason,
        }],
        "usageMetadata": {
            "promptTokenCount": 12,
            "candidatesTokenCount": 8,
            "totalTokenCount": 20,
        },
    }


class GeminiCarbonReviewTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name)
        self.prompt = self.root / "prompt.txt"
        self.prompt.write_text("离线周复盘提示词\n第二行", encoding="utf-8")
        self.output = self.root / "receipt.json"

    def run_cli(self, response=None, key_error=None, post_error=None):
        load_key = mock.Mock(return_value=TEST_KEY)
        if key_error is not None:
            load_key.side_effect = key_error
        post = mock.Mock()
        if post_error is not None:
            post.side_effect = post_error
        else:
            post.return_value = response or FakeResponse(response_payload())
        stdout = io.StringIO()
        with mock.patch.object(carbon.omni, "_load_key", load_key), \
                mock.patch.object(carbon.omni, "_post_with_retry", post), \
                redirect_stdout(stdout):
            exit_code = carbon.main([
                "--prompt-file", str(self.prompt),
                "--output", str(self.output),
            ])
        raw_receipt = self.output.read_text(encoding="utf-8")
        return exit_code, json.loads(raw_receipt), raw_receipt, post, stdout.getvalue()

    def test_text_only_payload_and_success_receipt(self):
        exit_code, receipt, raw_receipt, post, stdout = self.run_cli()

        self.assertEqual(exit_code, 0)
        self.assertEqual(receipt["status"], "SUCCESS")
        self.assertEqual(receipt["requestedModel"], "gemini-4-carbon")
        self.assertEqual(receipt["actualModel"], "gemini-4-carbon")
        self.assertEqual(receipt["requestedThinkingLevel"], "HIGH")
        self.assertIsNone(receipt["actualThinkingLevel"])
        self.assertFalse(receipt["productionChanges"])
        self.assertEqual(receipt["promptFile"], str(self.prompt.resolve()))
        self.assertEqual(
            receipt["promptSha256"],
            hashlib.sha256(self.prompt.read_bytes()).hexdigest(),
        )
        self.assertEqual(receipt["finishReason"], "STOP")
        self.assertEqual(receipt["review"], "Carbon offline review")
        self.assertEqual(receipt["rawContent"], "Carbon offline review")
        self.assertEqual(receipt["usage"]["totalTokenCount"], 20)
        self.assertIn("createdAt", receipt)

        url, payload = post.call_args.args
        self.assertEqual(
            url,
            f"{carbon.omni.API_BASE}/models/gemini-4-carbon:generateContent?key={TEST_KEY}",
        )
        self.assertEqual(payload["contents"], [{
            "role": "user",
            "parts": [{"text": self.prompt.read_bytes().decode("utf-8")}],
        }])
        self.assertEqual(payload["generationConfig"], {
            "thinkingConfig": {"thinkingLevel": "HIGH"},
            "maxOutputTokens": 32768,
        })
        self.assertNotIn("responseMimeType", payload["generationConfig"])
        self.assertEqual(post.call_args.kwargs, {"timeout": 300, "retries": 1})

        summary = json.loads(stdout)
        self.assertEqual(set(summary), {
            "status", "requestedModel", "actualModel", "usage", "output",
        })
        self.assertEqual(summary["output"], str(self.output.resolve()))
        self.assertNotIn(receipt["rawContent"], stdout)
        self.assertNotIn(TEST_KEY, stdout)
        self.assertNotIn(TEST_KEY, raw_receipt)

    def test_thought_parts_are_filtered(self):
        response = FakeResponse(response_payload(parts=[
            {"text": "hidden reasoning", "thought": True},
            {"text": "第一段"},
            {"text": "第二段"},
        ]))

        exit_code, receipt, _raw_receipt, _post, _stdout = self.run_cli(response=response)

        self.assertEqual(exit_code, 0)
        self.assertEqual(receipt["review"], "第一段\n第二段")
        self.assertEqual(receipt["rawContent"], "第一段\n第二段")
        self.assertNotIn("hidden reasoning", receipt["rawContent"])

    def test_model_mismatch_is_rejected_without_fallback(self):
        response = FakeResponse(response_payload(model="gemini-4-argon"))

        exit_code, receipt, _raw_receipt, post, _stdout = self.run_cli(response=response)

        self.assertEqual(exit_code, 1)
        self.assertEqual(receipt["status"], "FAILED")
        self.assertEqual(receipt["actualModel"], "gemini-4-argon")
        self.assertIn("Unexpected actual model", receipt["error"])
        self.assertEqual(post.call_count, 1)
        self.assertIn("models/gemini-4-carbon:generateContent", post.call_args.args[0])

    def test_missing_model_is_rejected(self):
        response = FakeResponse(response_payload(model=None))

        exit_code, receipt, _raw_receipt, _post, _stdout = self.run_cli(response=response)

        self.assertEqual(exit_code, 1)
        self.assertEqual(receipt["status"], "FAILED")
        self.assertIsNone(receipt["actualModel"])
        self.assertIn("Unexpected actual model", receipt["error"])

    def test_max_tokens_is_rejected_even_with_text(self):
        response = FakeResponse(response_payload(
            finish_reason="MAX_TOKENS",
            parts=[{"text": "partial review"}],
        ))

        exit_code, receipt, _raw_receipt, _post, _stdout = self.run_cli(response=response)

        self.assertEqual(exit_code, 1)
        self.assertEqual(receipt["status"], "FAILED")
        self.assertEqual(receipt["finishReason"], "MAX_TOKENS")
        self.assertEqual(receipt["review"], "partial review")
        self.assertEqual(receipt["rawContent"], "partial review")
        self.assertIn("finishReason must be STOP", receipt["error"])

    def test_empty_non_thought_text_is_rejected(self):
        response = FakeResponse(response_payload(parts=[
            {"text": "thought only", "thought": True},
        ]))

        exit_code, receipt, _raw_receipt, _post, _stdout = self.run_cli(response=response)

        self.assertEqual(exit_code, 1)
        self.assertEqual(receipt["status"], "FAILED")
        self.assertEqual(receipt["review"], "")
        self.assertEqual(receipt["rawContent"], "")
        self.assertIn("no non-thought text", receipt["error"])

    def test_http_error_is_redacted(self):
        response = FakeResponse(
            ok=False,
            status_code=400,
            text=f"request rejected for key={TEST_KEY}",
        )

        exit_code, receipt, raw_receipt, _post, stdout = self.run_cli(response=response)

        self.assertEqual(exit_code, 1)
        self.assertEqual(receipt["status"], "FAILED")
        self.assertIn("HTTP 400", receipt["error"])
        self.assertIn("<redacted>", receipt["error"])
        self.assertNotIn(TEST_KEY, raw_receipt)
        self.assertNotIn(TEST_KEY, stdout)

    def test_network_error_is_redacted(self):
        error = RuntimeError(f"network failed at https://example.invalid/?key={TEST_KEY}")

        def fail_with_transport_diagnostic(*_args, **_kwargs):
            print(f"transport diagnostic key={TEST_KEY}")
            raise error

        exit_code, receipt, raw_receipt, _post, stdout = self.run_cli(
            post_error=fail_with_transport_diagnostic,
        )

        self.assertEqual(exit_code, 1)
        self.assertEqual(receipt["status"], "FAILED")
        self.assertIn("<redacted>", receipt["error"])
        self.assertNotIn(TEST_KEY, raw_receipt)
        self.assertNotIn(TEST_KEY, stdout)
        self.assertEqual(json.loads(stdout)["status"], "FAILED")

    def test_key_failure_saves_receipt_without_sending_request(self):
        error = RuntimeError("Gemini key file unavailable")

        exit_code, receipt, _raw_receipt, post, stdout = self.run_cli(key_error=error)

        self.assertEqual(exit_code, 1)
        self.assertEqual(receipt["status"], "FAILED")
        self.assertEqual(receipt["requestedModel"], carbon.MODEL)
        self.assertIn("key file unavailable", receipt["error"])
        post.assert_not_called()
        self.assertEqual(json.loads(stdout)["status"], "FAILED")


if __name__ == "__main__":
    unittest.main()
