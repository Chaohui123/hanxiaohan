from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import os
from pathlib import Path
from typing import Any, Dict, Optional

from src import ALGO_VERSION, SCHEMA_VERSION
from src.iam_metadata import MetadataIamTokenProvider, assert_no_forbidden_static_credentials
from src.index import execute_weekly_pipeline, load_yaml_config
from src.storage_ledger import VerifiedWordstatStore, YandexIamObjectStorageBackend, LocalDirectoryStorageBackend
from src.wordstat_fetcher import (
    OutcomeUnknownHaltedError,
    QuotaBudgetExhaustedError,
    WordstatFetcher,
    WordstatPermissionDeniedError,
    WordstatUpstreamError,
)


def _event_id(event: Dict[str, Any], context: Any) -> str:
    messages = (event or {}).get("messages") or []
    metadata = (event or {}).get("event_metadata") or (messages[0].get("event_metadata") if messages else {}) or {}
    return str(metadata.get("event_id") or getattr(context, "request_id", None) or "manual-watermark-event")


def _save_ledger(
    store: VerifiedWordstatStore,
    event_id: str,
    status: str,
    full_result: Optional[Dict[str, Any]] = None,
) -> None:
    record = {
        "eventId": event_id,
        "status": status,
        "updatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "notes": ["Watermark probe precedes any full report; duplicate events never repeat upstream requests"],
    }
    if full_result:
        record["reportStorageKey"] = full_result.get("reportStorageKey")
        record["reportSha256"] = full_result.get("reportSha256")
    store.save_event_ledger(event_id, record)


def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    assert_no_forbidden_static_credentials()
    config = load_yaml_config(os.environ.get("WORDSTAT_CONFIG_PATH", str(Path(__file__).resolve().parent.parent / "config.yaml")))
    ws_cfg = config.get("wordstat", {})
    quota_cfg = config.get("quotaAndRate", {})
    iam = MetadataIamTokenProvider()
    if os.environ.get("WORDSTAT_STORAGE_BACKEND", "s3_iam") == "local":
        backend = LocalDirectoryStorageBackend(os.environ.get("WORDSTAT_LOCAL_STORAGE_DIR", "/tmp/wordstat-store"))
    else:
        backend = YandexIamObjectStorageBackend(os.environ["WORDSTAT_BUCKET_NAME"], iam.get_token)
    store = VerifiedWordstatStore(backend, prefix=os.environ.get("WORDSTAT_STORAGE_PREFIX", "wordstat-weekly"))
    event_id = _event_id(event, context)
    existing_event = store.get_event_ledger(event_id)
    if existing_event:
        completed = existing_event.get("status") == "COMPLETED"
        return {
            "statusCode": 200 if completed else 409,
            "status": "DUPLICATE_EVENT",
            "skippedDuplicateEvent": completed,
            "reviewRequiredBeforeRetry": not completed,
            "upstreamRequestsSent": False,
            "watermark": store.read_json("watermark/latest.json"),
        }

    run_date = date.fromisoformat(os.environ.get("WORDSTAT_OVERRIDE_RUN_DATE") or datetime.now(timezone.utc).date().isoformat())
    if run_date > datetime.now(timezone.utc).date():
        raise ValueError("水位检查日期不能是未来")
    _save_ledger(store, event_id, "IN_PROGRESS")
    previous = store.read_json("watermark/latest.json")
    previous_as_of = previous.get("sourceAsOf") if previous else None
    req_to = run_date - timedelta(days=run_date.weekday() + 1)
    lookback_weeks = int(ws_cfg.get("weeklyLookbackWeeks", 53))
    req_from = req_to - timedelta(weeks=lookback_weeks - 1, days=6)
    phrase = str(ws_cfg.get("watermarkBenchmarkPhrase") or config["seedPhrases"][0]["phrase"])
    regions = [int(ws_cfg.get("countryRegionId", 225))]
    devices = ws_cfg.get("devices", ["all"])
    fetcher = WordstatFetcher(
        folder_id=os.environ["YANDEX_CLOUD_FOLDER_ID"],
        token_getter=iam.get_token,
        store=store,
        run_id=f"watermark_{run_date.isoformat()}_{event_id}",
        run_date=run_date.isoformat(),
        base_url=ws_cfg.get("baseUrl", "https://searchapi.api.cloud.yandex.net/v2/wordstat"),
        max_rps=float(quota_cfg.get("maxRequestsPerSecond", 5.0)),
        daily_budget=int(quota_cfg.get("dailyRequestBudget", 600)),
        timeout_seconds=float(quota_cfg.get("requestTimeoutSeconds", 15.0)),
        max_retries_429=int(quota_cfg.get("maxRetries429", 3)),
        max_retries_503=int(quota_cfg.get("maxRetries503", 2)),
        unknown_outcome_cooldown_seconds=float(quota_cfg.get("unknownOutcomeCooldownSeconds", 3.0)),
        max_unknown_outcome_probes=int(quota_cfg.get("maxUnknownOutcomeProbes", 0)),
        http_client=(context or {}).get("offlineHttpClient") if isinstance(context, dict) else None,
    )
    try:
        response = fetcher.getDynamics(
            phrase=phrase,
            from_date=req_from.isoformat(),
            to_date=req_to.isoformat(),
            period="weekly",
            regions=regions,
            devices=devices,
            force_refresh=True,
        )
    except OutcomeUnknownHaltedError as exc:
        _save_ledger(store, event_id, "HALTED_OUTCOME_UNKNOWN")
        if previous:
            previous.update({
                "status": "CHECK_UNCERTAIN",
                "lastAttemptAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
                "lastEventId": event_id,
                "upstreamOutcome": "unknown_no_retry",
            })
            store.write_json_verified("watermark/latest.json", previous)
        raise RuntimeError("水位检查结果不明，不自动重发或启动全量") from exc
    except (WordstatUpstreamError, WordstatPermissionDeniedError, QuotaBudgetExhaustedError) as exc:
        _save_ledger(store, event_id, "FAILED")
        if previous:
            previous.update({
                "status": "CHECK_FAILED",
                "lastAttemptAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
                "lastEventId": event_id,
                "lastErrorType": type(exc).__name__,
            })
            store.write_json_verified("watermark/latest.json", previous)
        raise RuntimeError("水位检查失败，未启动全量；同一事件重试不会再次请求上游") from exc

    raw_key = fetcher.raw_receipt_keys[-1]
    raw_relative_key = raw_key.removeprefix(f"{store.prefix}/") if store.prefix else raw_key
    envelope = store.read_json(raw_relative_key)
    if not envelope or not envelope.get("rawPayloadSha256"):
        raise RuntimeError("水位原始回执缺失，禁止启动全量")
    response_hash = envelope["rawPayloadSha256"]
    source_as_of = response.sourceAsOf
    checked_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    if not source_as_of:
        status = "NO_DATA"
        trigger_reason = "empty_upstream_response_not_zero"
    elif previous_as_of and source_as_of < previous_as_of:
        status = "REGRESSION_BLOCKED"
        trigger_reason = "observed_watermark_older_than_accepted"
    elif previous and source_as_of == previous_as_of and response_hash == previous.get("responseHash"):
        status = "NO_UPSTREAM_CHANGE"
        trigger_reason = "same_source_and_raw_response_hash"
    else:
        status = "FULL_REPORT_REQUIRED"
        trigger_reason = "initial_baseline" if not previous else "watermark_advanced" if source_as_of > previous_as_of else "historical_revision"

    full_result: Optional[Dict[str, Any]] = None
    if status == "FULL_REPORT_REQUIRED":
        full_result = execute_weekly_pipeline(
            config=config,
            store=store,
            folder_id=os.environ["YANDEX_CLOUD_FOLDER_ID"],
            token_getter=iam.get_token,
            event_id=f"{event_id}:full",
            run_date_str=run_date.isoformat(),
            dry_run=False,
            http_client=(context or {}).get("offlineHttpClient") if isinstance(context, dict) else None,
            revision_token=response_hash,
        )
        if full_result.get("statusCode", 500) >= 500:
            _save_ledger(store, event_id, "FAILED", full_result)
            raise RuntimeError("水位变化后的全量报告失败；不重放上游事件")

    watermark = {
        "schemaVersion": SCHEMA_VERSION,
        "algoVersion": ALGO_VERSION,
        "benchmark": {
            "phrase": phrase,
            "period": "weekly",
            "regions": regions,
            "devices": devices,
            "operatorMode": "plus_only_weekly",
            "fromDate": req_from.isoformat(),
            "toDate": req_to.isoformat(),
        },
        "sourceAsOf": previous_as_of if status in ("NO_DATA", "REGRESSION_BLOCKED") and previous_as_of else source_as_of,
        "observedSourceAsOf": source_as_of,
        "lastCheckedAt": checked_at,
        "responseHash": response_hash,
        "rawReceiptKey": raw_key,
        "status": "FULL_REPORT_GENERATED" if full_result else status,
        "triggerReason": trigger_reason,
        "lastEventId": event_id,
        "lastFullReportId": full_result.get("reportId") if full_result else previous.get("lastFullReportId") if previous else None,
        "lastReportStorageKey": full_result.get("reportStorageKey") if full_result else previous.get("lastReportStorageKey") if previous else None,
        "lastReportSha256": full_result.get("reportSha256") if full_result else previous.get("lastReportSha256") if previous else None,
        "fullReportUpstreamRequestsSent": bool(full_result),
        "note": "仅基准词weekly水位前进或原始响应修订才全量；lastCheckedAt不是sourceAsOf，缺失不补0。",
    }
    store.write_json_verified("watermark/latest.json", watermark)
    _save_ledger(store, event_id, "COMPLETED", full_result)
    return {
        "statusCode": 200,
        "status": watermark["status"],
        "triggerReason": trigger_reason,
        "sourceAsOf": watermark["sourceAsOf"],
        "lastCheckedAt": checked_at,
        "responseHash": response_hash,
        "fullReport": full_result,
        "skippedDuplicateEvent": False,
        "benchmarkUpstreamRequests": 1,
    }
