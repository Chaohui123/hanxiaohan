from __future__ import annotations

import argparse
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import logging
import os
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
import httpx
import yaml

from src import ALGO_VERSION, PIPELINE_VERSION, SCHEMA_VERSION
from src.daily_gap import fill_daily_gap
from src.iam_metadata import MetadataIamTokenProvider, assert_no_forbidden_static_credentials
from src.models import KeywordObservation, SellerValidationContext, WeeklyObservationReport
from src.ozon_analyzer import OzonWordstatAnalyzer
from src.storage_ledger import (
    LocalDirectoryStorageBackend,
    StorageIntegrityError,
    StoragePermissionError,
    VerifiedWordstatStore,
    YandexIamObjectStorageBackend,
)
from src.wordstat_fetcher import (
    OutcomeUnknownHaltedError,
    QuotaBudgetExhaustedError,
    WordstatFetcher,
    WordstatPermissionDeniedError,
    WordstatUpstreamError,
)

logger = logging.getLogger("onzo.wordstat.weekly")


def load_yaml_config(config_path: str | Path) -> Dict[str, Any]:
    with Path(config_path).open("r", encoding="utf-8") as file:
        value = yaml.safe_load(file)
    if not isinstance(value, dict):
        raise ValueError("config.yaml 必须是对象")
    return value


def compute_config_hash(config: Dict[str, Any]) -> str:
    blob = json.dumps(config, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()[:16]


def execute_weekly_pipeline(
    config: Dict[str, Any],
    store: VerifiedWordstatStore,
    folder_id: str,
    token_getter: Callable[[], str],
    event_id: str,
    run_date_str: str,
    dry_run: bool = True,
    http_client: Optional[httpx.Client] = None,
    offline_fixture: bool = False,
    revision_token: Optional[str] = None,
) -> Dict[str, Any]:
    assert_no_forbidden_static_credentials()
    existing_event = store.get_event_ledger(event_id)
    if existing_event:
        completed = existing_event.get("status") == "COMPLETED"
        return {
            "statusCode": 200 if completed else 409,
            "skippedDuplicateEvent": completed,
            "reviewRequiredBeforeRetry": not completed,
            "eventId": event_id,
            "reportStorageKey": existing_event.get("reportStorageKey"),
            "reportSha256": existing_event.get("reportSha256"),
            "upstreamRequestsSent": False,
        }

    run_dt = date.fromisoformat(run_date_str)
    if run_dt > datetime.now(timezone.utc).date():
        raise ValueError("运行日期不能是未来")
    iso_year, iso_week, _ = run_dt.isocalendar()
    iso_week_str = f"{iso_year}-W{iso_week:02d}"
    cfg_hash = compute_config_hash(config)
    run_id = f"run_{run_date_str}_{hashlib.sha1(event_id.encode('utf-8')).hexdigest()[:8]}"
    now_iso = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    store.save_event_ledger(event_id, {
        "eventId": event_id,
        "runId": run_id,
        "isoWeek": iso_week_str,
        "status": "IN_PROGRESS",
        "updatedAt": now_iso,
        "notes": ["Pipeline started; no upstream request before this ledger write"],
    })

    ws_cfg = config.get("wordstat", {})
    quota_cfg = config.get("quotaAndRate", {})
    city_meta = {int(city["id"]): city for city in ws_cfg.get("referenceCities", [])}
    fetcher = WordstatFetcher(
        folder_id=folder_id,
        token_getter=token_getter,
        store=store,
        run_id=run_id,
        run_date=run_date_str,
        base_url=ws_cfg.get("baseUrl", "https://searchapi.api.cloud.yandex.net/v2/wordstat"),
        translate_url=ws_cfg.get("translateUrl", "https://translate.api.cloud.yandex.net/translate/v2/translate"),
        max_rps=float(quota_cfg.get("maxRequestsPerSecond", 5.0)),
        daily_budget=int(quota_cfg.get("dailyRequestBudget", 600)),
        timeout_seconds=float(quota_cfg.get("requestTimeoutSeconds", 15.0)),
        max_retries_429=int(quota_cfg.get("maxRetries429", 3)),
        max_retries_503=int(quota_cfg.get("maxRetries503", 2)),
        unknown_outcome_cooldown_seconds=float(quota_cfg.get("unknownOutcomeCooldownSeconds", 3.0)),
        max_unknown_outcome_probes=int(quota_cfg.get("maxUnknownOutcomeProbes", 0)),
        city_meta_by_id=city_meta,
        http_client=http_client,
    )

    lookback_weeks = int(ws_cfg.get("weeklyLookbackWeeks", 53))
    req_to_dt = run_dt - timedelta(days=run_dt.weekday() + 1)
    req_from_dt = req_to_dt - timedelta(weeks=lookback_weeks - 1, days=6)
    seeds = config.get("seedPhrases", [])
    zh_map = {
        seed["phrase"]: f"{seed.get('zhHint') or seed['phrase']} [辅助阅读草稿]"
        for seed in seeds
    }
    analyzer = OzonWordstatAnalyzer(config=config, run_date=run_date_str)
    evaluated: List[KeywordObservation] = []
    halted_by_critical = False
    halted_unknown = False
    country_regions = [int(ws_cfg.get("countryRegionId", 225))]
    devices = ws_cfg.get("devices", ["all"])

    def evaluate_phrase(
        phrase: str,
        zh_draft: str,
        category: str,
        seed_status: str,
        fetch_top: bool = False,
        fetch_api: bool = True,
    ) -> tuple[KeywordObservation, Any]:
        nonlocal halted_by_critical, halted_unknown
        top_resp = None
        dynamics_resp = None
        regions_resp = None
        daily_gap_resp = None
        disposition, _ = analyzer._check_governance_disposition(phrase)
        if fetch_api and disposition == "eligible_observation":
            try:
                if fetch_top:
                    top_resp = fetcher.getTop(
                        phrase=phrase,
                        regions=country_regions,
                        devices=devices,
                        num_phrases=int(ws_cfg.get("topNumPhrases", 50)),
                    )
                dynamics_resp = fetcher.getDynamics(
                    phrase=phrase,
                    from_date=req_from_dt.isoformat(),
                    to_date=req_to_dt.isoformat(),
                    period="weekly",
                    regions=country_regions,
                    devices=devices,
                    strict_operator_strategy=ws_cfg.get("strictOperatorStrategy", "separate_daily_caliber"),
                    daily_strict_lookback_days=int(ws_cfg.get("dailyStrictLookbackDays", 30)),
                )
                regions_resp = fetcher.getRegionsDistribution(phrase=phrase, region_type="cities", devices=devices)
                if ws_cfg.get("dailyGapFillEnabled", False):
                    daily_gap_resp = fill_daily_gap(
                        fetcher=fetcher,
                        weekly=dynamics_resp,
                        run_date=run_date_str,
                        chunk_days=int(ws_cfg.get("dailyGapChunkDays", 30)),
                    )
            except OutcomeUnknownHaltedError:
                halted_unknown = True
            except (QuotaBudgetExhaustedError, WordstatPermissionDeniedError):
                halted_by_critical = True
            except WordstatUpstreamError:
                pass
        observation = analyzer.analyze_keyword(
            phrase=phrase,
            zh_draft=zh_draft,
            category=category,
            seed_status=seed_status,
            requested_from=req_from_dt.isoformat(),
            requested_to=req_to_dt.isoformat(),
            top_resp=top_resp,
            dynamics_resp=dynamics_resp,
            regions_resp=regions_resp,
        )
        observation.dailyGapFill = daily_gap_resp
        return observation, top_resp

    seen_phrases = {" ".join(seed["phrase"].strip().lower().replace("ё", "е").split()) for seed in seeds}
    expansion_count = 0
    max_expansions = int(ws_cfg.get("maxExpansionCandidatesPerReport", 20))
    max_per_seed = int(ws_cfg.get("maxExpansionCandidatesPerSeed", 3))
    for seed in seeds:
        if halted_by_critical or halted_unknown:
            break
        phrase = seed["phrase"]
        observation, top_resp = evaluate_phrase(
            phrase=phrase,
            zh_draft=zh_map[phrase],
            category=seed.get("category", "uncategorized"),
            seed_status=seed.get("seedStatus", "pending_verification_example"),
            fetch_top=True,
        )
        evaluated.append(observation)
        if not top_resp or halted_by_critical or halted_unknown:
            continue
        seed_expansions = 0
        for candidate in top_resp.results:
            if expansion_count >= max_expansions or seed_expansions >= max_per_seed:
                break
            normalized = " ".join(candidate.phrase.strip().lower().replace("ё", "е").split())
            if not normalized or normalized in seen_phrases:
                continue
            seen_phrases.add(normalized)
            disposition, reason = analyzer._check_governance_disposition(candidate.phrase)
            _, brand_flags, _ = analyzer._evaluate_intent_and_brands(candidate.phrase)
            expansion_count += 1
            seed_expansions += 1
            if disposition != "eligible_observation" or brand_flags:
                excluded, _ = evaluate_phrase(
                    phrase=candidate.phrase,
                    zh_draft=f"{candidate.phrase} [待人工核译草稿]",
                    category="uncategorized_expansion",
                    seed_status="top_result_excluded_before_scoring",
                    fetch_api=False,
                )
                excluded.disposition = "expansion_candidate_only"
                excluded.dispositionReason = reason or "含品牌/平台关联词，仅留核查记录，不自动进入扩词评分或新品结论"
                evaluated.append(excluded)
                continue
            expanded, _ = evaluate_phrase(
                phrase=candidate.phrase,
                zh_draft=f"{candidate.phrase} [待人工核译草稿]",
                category="uncategorized_expansion",
                seed_status="top_result_expansion_requires_seller_verification",
            )
            evaluated.append(expanded)
            if halted_by_critical or halted_unknown:
                break

    top10, blocked = analyzer.cluster_and_rank_top_observations(evaluated)
    valid_as_of_dates = sorted(item.sourceAsOf for item in evaluated if item.sourceAsOf)
    global_as_of_min = valid_as_of_dates[0] if valid_as_of_dates else None
    global_as_of_max = valid_as_of_dates[-1] if valid_as_of_dates else None
    daily_as_of_dates = sorted(
        item.dailyGapFill.sourceAsOf
        for item in evaluated
        if item.dailyGapFill and item.dailyGapFill.sourceAsOf
    )
    latest_daily_as_of = daily_as_of_dates[-1] if daily_as_of_dates else None
    revision_payload = {
        "observations": [item.model_dump(mode="json") for item in evaluated],
        "failures": [item.model_dump(mode="json") for item in fetcher.failed_diagnostics],
    }
    content_revision = hashlib.sha256(VerifiedWordstatStore.canonical_json_bytes(revision_payload)).hexdigest()
    idempotency_key = f"{iso_week_str}:{cfg_hash}:{PIPELINE_VERSION}:{revision_token or content_revision}"
    scored_count = sum(1 for item in top10 if item.score.observationPriorityScore is not None)
    primary_failures = [item for item in fetcher.failed_diagnostics if item.stage != "daily_gap"]
    daily_failures = [item for item in fetcher.failed_diagnostics if item.stage == "daily_gap"]
    if halted_by_critical or halted_unknown or (scored_count == 0 and primary_failures):
        overall_status = "failed_alert_only"
    elif primary_failures or daily_failures or scored_count < len(top10):
        overall_status = "degraded_partial"
    else:
        overall_status = "success"

    seller_cfg = config.get("sellerContextNotice", {})
    accumulated = int(seller_cfg.get("selfBuiltAccumulatedDays", 7))
    target = int(seller_cfg.get("selfBuiltTargetDays", 28))
    seller_context = SellerValidationContext(
        nativeWindowDays=int(seller_cfg.get("nativeWindowDays", 7)),
        nativeBatchPages=int(seller_cfg.get("nativeBatchPages", 199)),
        nativeBatchRows=int(seller_cfg.get("nativeBatchRows", 9949)),
        selfBuiltAccumulatedDays=accumulated,
        selfBuiltTargetDays=target,
        selfBuiltProgressLabel=f"{accumulated}/{target}天",
        promoAutoDecision=False,
        mandatoryHumanGates=[
            "Ozon Seller当前真实查询词与购买意图核验",
            "同型竞品、供货、准确变体、关键参数与真实单元经济复核",
            "合规、8图双视频与独立终审；不得仅凭词频上架",
        ],
    )
    disclaimers = [
        "本报告仅用于选品观察排队，不是最终选品机会分或上架授权。",
        "观察阈值不自动删除需求；高搜索量不自动等于竞争激烈，低搜索量不自动等于蓝海。",
        "扩词仅取topRequests结果并受总量、单种子、治理与预算约束；associations只留原始回执，不自动扩展为需求或评分。",
        "季节性仅提示补证、供货评估与内容准备，不是提前备货指令。",
        "daily只补入实际返回的日粒度点，不与weekly周量混算；检查时间不等于数据截止时间，缺失不补0。",
        "近1-3天需求以Ozon Seller原生7天及自建28天为主；Wordstat只作长期趋势和季节性参考，不用于本周飙升结论。",
        "只读分析，不抓Seller网页、不创建商品、不改价、不改库存、不开广告、不采购，PROMO_AUTO_DECISION=false。",
    ]
    if offline_fixture:
        disclaimers.append("本次使用本地离线fixture，只验证格式与流程，不是实际市场需求或经营结果。")
    report = WeeklyObservationReport(
        schemaVersion=SCHEMA_VERSION,
        algoVersion=ALGO_VERSION,
        pipelineVersion=PIPELINE_VERSION,
        reportId=run_id,
        idempotencyKey=idempotency_key,
        eventId=event_id,
        isoWeek=iso_week_str,
        runDate=run_date_str,
        generatedAt=datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        overallStatus=overall_status,
        globalSourceAsOfMax=global_as_of_max,
        globalSourceAsOfMin=global_as_of_min,
        latestDailySourceAsOf=latest_daily_as_of,
        budgetUsedToday=store.get_daily_budget_used(run_date_str),
        budgetLimitDaily=int(quota_cfg.get("dailyRequestBudget", 600)),
        top10Observations=top10,
        allEvaluatedObservations=evaluated,
        blockedOrExcludedItems=blocked,
        failedRequests=fetcher.failed_diagnostics,
        rawReceiptKeys=fetcher.raw_receipt_keys,
        sellerValidationContext=seller_context,
        disclaimers=disclaimers,
    )
    report_key = f"reports/v1/{iso_week_str}/report_{run_id}.json"
    full_key, report_sha256, report_byte_len = store.write_and_verify_model(
        relative_key=report_key,
        model_instance=report,
        model_cls=WeeklyObservationReport,
        expected_source_as_of=global_as_of_max,
        require_source_as_of_check=True,
    )
    latest_valid_key = None
    if overall_status in ("success", "degraded_partial") and scored_count > 0:
        latest_valid_key = store.promote_latest_valid_manifest(
            iso_week=iso_week_str,
            report_key=full_key,
            report_sha256=report_sha256,
            report_byte_len=report_byte_len,
            source_as_of_max=global_as_of_max,
            updated_at=report.generatedAt,
        )
    latest_attempt_key = store.record_latest_attempt_manifest(
        report_key=full_key,
        report_sha256=report_sha256,
        report_byte_len=report_byte_len,
        overall_status=overall_status,
        source_as_of_max=global_as_of_max,
        updated_at=report.generatedAt,
    )
    ledger_status = "HALTED_OUTCOME_UNKNOWN" if halted_unknown else "FAILED" if overall_status == "failed_alert_only" else "COMPLETED"
    store.save_event_ledger(event_id, {
        "eventId": event_id,
        "runId": run_id,
        "isoWeek": iso_week_str,
        "status": ledger_status,
        "updatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "reportStorageKey": full_key,
        "reportSha256": report_sha256,
        "notes": [f"latestAttempt={latest_attempt_key}", f"latestValid={latest_valid_key}"],
    })
    return {
        "statusCode": 200 if overall_status != "failed_alert_only" else 500,
        "skippedDuplicateEvent": False,
        "dryRun": dry_run,
        "offlineFixture": offline_fixture,
        "overallStatus": overall_status,
        "reportId": run_id,
        "idempotencyKey": idempotency_key,
        "reportStorageKey": full_key,
        "reportSha256": report_sha256,
        "reportByteLength": report_byte_len,
        "latestAttemptManifest": latest_attempt_key,
        "latestValidManifest": latest_valid_key,
        "sourceAsOf": global_as_of_max,
        "dailySourceAsOf": latest_daily_as_of,
        "scoredCount": scored_count,
        "upstreamRequestCount": store.get_daily_budget_used(run_date_str),
    }


class OfflineResponse:
    status_code = 200

    def __init__(self, payload: Dict[str, Any]):
        self.payload = payload

    def json(self):
        return self.payload


class OfflineFixtureClient:
    def __init__(self, run_date: str):
        run_dt = date.fromisoformat(run_date)
        anchor = run_dt - timedelta(days=run_dt.weekday() + 7)
        self.points = [
            {"date": (anchor - timedelta(weeks=7 - index)).isoformat(), "count": str(900 + index * 50), "share": 0.001}
            for index in range(8)
        ]

    def post(self, url: str, json: Dict[str, Any], headers: Dict[str, str]):
        if url.endswith("/topRequests"):
            return OfflineResponse({"totalCount": "1000", "results": [{"phrase": json["phrase"], "count": "1000"}], "associations": []})
        if url.endswith("/dynamics"):
            if json.get("period") == "PERIOD_DAILY":
                start = date.fromisoformat(json["fromDate"][:10])
                end = date.fromisoformat(json["toDate"][:10])
                daily_points = []
                current = start
                while current <= end:
                    daily_points.append({"date": current.isoformat(), "count": "100", "share": 0.001})
                    current += timedelta(days=1)
                return OfflineResponse({"results": daily_points})
            return OfflineResponse({"results": self.points})
        if url.endswith("/regions"):
            return OfflineResponse({"results": [
                {"region": "213", "count": "100", "share": 0.1, "affinityIndex": 150.0},
                {"region": "2", "count": "100", "share": 0.1, "affinityIndex": 150.0},
                {"region": "54", "count": "100", "share": 0.1, "affinityIndex": 150.0},
            ]})
        raise ValueError(f"Offline fixture不允许请求未登记地址: {url}")


def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    assert_no_forbidden_static_credentials()
    messages = (event or {}).get("messages") or []
    payload = (event or {}).get("payload") or (messages[0].get("payload") if messages else None)
    if payload in ("wordstat-weekly", "wordstat-watermark"):
        from src.watermark import handler as watermark_handler
        return watermark_handler(event, context)
    event_meta = (event or {}).get("event_metadata") or (messages[0].get("event_metadata") if messages else {}) or {}
    event_id = str(event_meta.get("event_id") or getattr(context, "request_id", None) or "manual-event")
    run_date = os.environ.get("WORDSTAT_OVERRIDE_RUN_DATE") or datetime.now(timezone.utc).date().isoformat()
    config = load_yaml_config(os.environ.get("WORDSTAT_CONFIG_PATH", str(Path(__file__).resolve().parent.parent / "config.yaml")))
    iam_provider = MetadataIamTokenProvider()
    storage_mode = os.environ.get("WORDSTAT_STORAGE_BACKEND", "s3_iam")
    if storage_mode == "s3_iam":
        backend = YandexIamObjectStorageBackend(
            bucket_name=os.environ["WORDSTAT_BUCKET_NAME"],
            token_getter=iam_provider.get_token,
        )
    elif storage_mode == "local":
        backend = LocalDirectoryStorageBackend(os.environ.get("WORDSTAT_LOCAL_STORAGE_DIR", "/tmp/wordstat_store"))
    else:
        raise ValueError("WORDSTAT_STORAGE_BACKEND只支持s3_iam或local")
    store = VerifiedWordstatStore(backend=backend, prefix=os.environ.get("WORDSTAT_STORAGE_PREFIX", "wordstat-weekly"))
    try:
        result = execute_weekly_pipeline(
            config=config,
            store=store,
            folder_id=os.environ["YANDEX_CLOUD_FOLDER_ID"],
            token_getter=iam_provider.get_token,
            event_id=event_id,
            run_date_str=run_date,
            dry_run=os.environ.get("WORDSTAT_DRY_RUN", "false").lower() in ("1", "true", "yes"),
        )
        if result["statusCode"] >= 500:
            raise RuntimeError(f"周报处于告警态 ({result['overallStatus']})，事件账本已保存，Timer重试不得再次调用上游")
        return result
    except (StorageIntegrityError, StoragePermissionError) as exc:
        logger.error("存储完整性或权限异常，未覆盖上一份成功报告: %s", exc)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description="ONZO Wordstat观察周报离线dry-run；不调用真实API，不发送飞书")
    parser.add_argument("--config", default=str(Path(__file__).resolve().parent.parent / "config.yaml"))
    parser.add_argument("--run-date", default=datetime.now(timezone.utc).date().isoformat())
    parser.add_argument("--event-id", default="offline-dry-run")
    parser.add_argument("--output-json", default="./.local_wordstat_store/dry_run_output.json")
    parser.add_argument("--local-store", default="./.local_wordstat_store")
    parser.add_argument("--dry-run", action="store_true", default=True)
    args = parser.parse_args()
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    config = load_yaml_config(args.config)
    store = VerifiedWordstatStore(LocalDirectoryStorageBackend(args.local_store), prefix="wordstat-weekly")
    result = execute_weekly_pipeline(
        config=config,
        store=store,
        folder_id="offline-fixture",
        token_getter=lambda: "offline-fixture-not-a-credential",
        event_id=args.event_id,
        run_date_str=args.run_date,
        dry_run=True,
        http_client=OfflineFixtureClient(args.run_date),
        offline_fixture=True,
    )
    output = Path(args.output_json)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"status": "OFFLINE_DRY_RUN_ONLY", "output": str(output), "reportId": result["reportId"], "feishuSent": False, "realApiCalled": False}, ensure_ascii=False))


if __name__ == "__main__":
    main()
