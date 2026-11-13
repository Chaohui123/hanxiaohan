import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from scripts.weekly_report_validation import validate_competitor_report, validate_source

NOW = datetime(2026, 11, 3, 12, 0, tzinfo=timezone.utc)


def competitor_report(captured_at):
    return {
        "runId": "run-1",
        "completedAt": "2026-11-03T11:00:00Z",
        "dryRun": False,
        "fatalError": None,
        "filters": {},
        "totals": {"fetchFailed": 0, "identityMismatch": 0, "comparisonMissingRequired": 0, "uploadFailures": 0},
        "links": [{"includeInPriceComparison": True, "snapshot": {"capturedAt": captured_at}}],
        "pendingReconciliation": {"count": 0, "items": []},
        "reconciliationErrors": [],
    }


def validated_report(report, now):
    return validate_competitor_report(report, now, last_run=report)


class WeeklyValidationTest(unittest.TestCase):
    def test_missing_or_failed_last_run_cannot_use_old_healthy_latest(self):
        report = competitor_report("2026-11-03T10:00:00Z")
        self.assertFalse(validate_competitor_report(report, NOW)["usable"])
        failed = dict(report, runId="run-failed", fatalError="Ozon translation channel returned HTTP 429")
        result = validate_competitor_report(report, NOW, last_run=failed)
        self.assertFalse(result["usable"])
        self.assertIn("latest run failed", result["lastRunReason"])

    def test_any_future_direct_snapshot_is_rejected(self):
        report = competitor_report("2026-11-03T10:00:00Z")
        report["links"].append({"includeInPriceComparison": True, "snapshot": {"capturedAt": "2026-11-03T12:00:01Z"}})
        self.assertFalse(validated_report(report, NOW)["usable"])
        self.assertFalse(validate_source({"collectedAt": "2026-11-03T12:00:01Z"}, NOW)["usable"])

    def test_carried_snapshot_older_than_24h_is_stale_even_with_fresh_completion(self):
        result = validated_report(competitor_report("2026-11-02T10:00:00Z"), NOW)
        self.assertTrue(result["stale"])
        self.assertFalse(result["usable"])
        self.assertEqual(result["oldestDirectAgeHours"], 26)

    def test_failures_and_pending_reconciliation_are_not_healthy_zero(self):
        report = competitor_report("2026-11-03T10:00:00Z")
        report["totals"]["uploadFailures"] = 1
        report["pendingReconciliation"] = {"count": 1, "items": [{"offerId": "A"}]}
        result = validated_report(report, NOW)
        self.assertFalse(result["usable"])
        self.assertEqual(result["failureCounts"]["uploadFailures"], 1)
        self.assertEqual(result["pendingReconciliationCount"], 1)

    def test_excluded_failures_do_not_block_valid_direct_rows(self):
        report = competitor_report("2026-11-03T10:00:00Z")
        report["totals"].update({"fetchFailed": 2, "identityMismatch": 1, "comparisonFetchFailed": 0, "comparisonIdentityMismatch": 0})
        result = validated_report(report, NOW)
        self.assertTrue(result["usable"])
        report["totals"]["comparisonFetchFailed"] = 1
        self.assertFalse(validated_report(report, NOW)["usable"])

    def test_old_or_missing_source_is_not_current(self):
        self.assertFalse(validate_source({"collectedAt": "2026-10-26T00:00:00Z"}, NOW)["usable"])
        self.assertFalse(validate_source({}, NOW)["usable"])
        self.assertTrue(validate_source({"collectedAt": "2026-11-03T11:00:00Z"}, NOW)["usable"])

    def test_future_direct_report_is_stale_not_zero_age(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.json"
            direct = Path(directory) / "direct.json"
            source.write_text(json.dumps({
                "collectedAt": "2026-11-03T11:00:00Z",
                "operationsPeriod": {"dateFrom": "2026-10-28", "dateTo": "2026-11-03"},
                "operationsTotals": {},
            }), encoding="utf-8")
            direct.write_text(json.dumps({"collectedAt": "2099-01-01T00:00:00Z"}), encoding="utf-8")
            result = subprocess.run([
                sys.executable, "scripts/weekly-model-prompt.py", "--source", str(source), "--direct-report", str(direct),
            ], check=True, capture_output=True, text=True, encoding="utf-8")
            self.assertIn('"stale":true', result.stdout)
            self.assertNotIn('"stale":false', result.stdout)

    def test_real_prompt_uses_remote_direct_regular_price_rules(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.json"
            report = Path(directory) / "competitor.json"
            source.write_text(json.dumps({
                "collectedAt": "2026-11-03T11:00:00Z",
                "operationsPeriod": {"dateFrom": "2026-10-28", "dateTo": "2026-11-03"},
                "operationsTotals": {"orderedRevenueRub": 0, "orderedUnits": 0},
            }), encoding="utf-8")
            report.write_text(json.dumps(competitor_report("2026-11-03T10:00:00Z")), encoding="utf-8")
            result = subprocess.run([
                sys.executable, "scripts/weekly-model-prompt.py", "--source", str(source),
                "--competitor-report", str(report), "--direct-report", str(Path(directory) / "missing.json"),
            ], check=True, capture_output=True, text=True, encoding="utf-8")
            self.assertIn("direct_comparable", result.stdout)
            self.assertIn("priceRegular", result.stdout)
            self.assertIn("服务器远程采集", result.stdout)
            self.assertNotIn("竞品采集须迁移到服务器或第三方", result.stdout)


if __name__ == "__main__":
    unittest.main()
