from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path
from typing import Any, Dict, List
import json
import os
import subprocess
import sys
from unittest import mock
import httpx
import pytest

from src.iam_metadata import SecurityConfigurationError, assert_no_forbidden_static_credentials
from src.index import execute_weekly_pipeline, load_yaml_config
from src.ozon_analyzer import OzonWordstatAnalyzer
from src.storage_ledger import (
    LocalDirectoryStorageBackend,
    StorageIntegrityError,
    VerifiedWordstatStore,
)
from src.wordstat_fetcher import (
    OutcomeUnknownHaltedError,
    WordstatFetcher,
    WordstatPermissionDeniedError,
    validate_monthly_window_dates,
)

PROJECT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = load_yaml_config(PROJECT_DIR / "config.yaml")


def _build_weekly_points(end_monday_iso: str, weeks: int = 48, base: int = 5000) -> List[Dict[str, Any]]:
    end_dt = date.fromisoformat(end_monday_iso)
    start_dt = end_dt - timedelta(weeks=weeks - 1)
    rows: List[Dict[str, Any]] = []
    for idx in range(weeks):
        d = start_dt + timedelta(weeks=idx)
        cnt = base + (idx * 50)
        rows.append({"date": d.isoformat(), "count": str(cnt), "share": 0.0021})
    return rows


def test_forbidden_static_credentials_rejected() -> None:
    with pytest.raises(SecurityConfigurationError):
        assert_no_forbidden_static_credentials({"YANDEX_API_KEY": "AQVN-forbidden-static-key"})
    with pytest.raises(SecurityConfigurationError):
        assert_no_forbidden_static_credentials({"FEISHU_WEBHOOK_URL": "https://open.feishu.cn/fake"})


def test_429_retry_after_and_503_backoff_then_success(tmp_path: Path) -> None:
    store = VerifiedWordstatStore(LocalDirectoryStorageBackend(tmp_path))
    sleep_calls: List[float] = []
    call_seq = {"n": 0}

    def mock_handler(request: httpx.Request) -> httpx.Response:
        call_seq["n"] += 1
        if call_seq["n"] == 1:
            return httpx.Response(429, headers={"Retry-After": "2.5"}, json={"message": "Too Many Requests"})
        if call_seq["n"] == 2:
            return httpx.Response(503, json={"message": "Service Unavailable"})
        return httpx.Response(
            200,
            json={
                "totalCount": "12500",
                "results": [{"phrase": "вакуумные пакеты для одежды", "count": "8900"}],
                "associations": [{"phrase": "чехол для переезда", "count": "3100"}],
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(mock_handler))
    fetcher = WordstatFetcher(
        folder_id="b1gtestfolder",
        token_getter=lambda: "iam-token-mock",
        store=store,
        run_id="run_test_retry",
        run_date="2026-11-09",
        http_client=client,
        sleeper=lambda s: sleep_calls.append(s),
    )
    top = fetcher.getTop("вакуумные пакеты для одежды", regions=[225], devices=["all"])
    assert call_seq["n"] == 3
    assert 2.5 in sleep_calls
    assert top.totalCount == 12500
    assert len(top.associations) == 1


def test_outcome_unknown_not_blindly_retried(tmp_path: Path) -> None:
    store = VerifiedWordstatStore(LocalDirectoryStorageBackend(tmp_path))
    attempts = {"count": 0}

    def timeout_transport(request: httpx.Request) -> httpx.Response:
        attempts["count"] += 1
        raise httpx.ReadTimeout("Read timed out after request sent", request=request)

    client = httpx.Client(transport=httpx.MockTransport(timeout_transport))
    fetcher = WordstatFetcher(
        folder_id="b1gtestfolder",
        token_getter=lambda: "iam-token-mock",
        store=store,
        run_id="run_unknown",
        run_date="2026-11-09",
        max_unknown_outcome_probes=0,
        http_client=client,
        sleeper=lambda _: None,
    )
    with pytest.raises(OutcomeUnknownHaltedError):
        fetcher.getRegionsDistribution("вакуумные пакеты для одежды", region_type="cities")
    assert attempts["count"] == 1

    with pytest.raises(OutcomeUnknownHaltedError):
        fetcher.getRegionsDistribution("вакуумные пакеты для одежды", region_type="cities")
    assert attempts["count"] == 1

    with pytest.raises(OutcomeUnknownHaltedError):
        fetcher.getRegionsDistribution("вакуумные пакеты для одежды", region_type="cities")
    assert attempts["count"] == 1


def test_403_minimal_permission_fails_fast_without_retry(tmp_path: Path) -> None:
    store = VerifiedWordstatStore(LocalDirectoryStorageBackend(tmp_path))
    calls = {"n": 0}

    def forbidden_transport(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(403, json={"message": "Permission denied"})

    fetcher = WordstatFetcher(
        folder_id="b1gtestfolder",
        token_getter=lambda: "iam-token-mock",
        store=store,
        run_id="run_403",
        run_date="2026-11-09",
        http_client=httpx.Client(transport=httpx.MockTransport(forbidden_transport)),
        sleeper=lambda _: None,
    )
    with pytest.raises(WordstatPermissionDeniedError):
        fetcher.getTop("вакуумные пакеты для одежды", regions=[225], devices=["all"])
    assert calls["n"] == 1


def test_monthly_october_missing_not_zero_filled_and_end_of_month_check(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        validate_monthly_window_dates("2026-01-01", "2026-10-30")
    validate_monthly_window_dates("2026-01-01", "2026-10-31")

    store = VerifiedWordstatStore(LocalDirectoryStorageBackend(tmp_path))
    nine_months = [
        {"date": f"2026-{m:02d}-01", "count": str(4000 + m * 100), "share": 0.0015}
        for m in range(1, 10)
    ]
    client = httpx.Client(
        transport=httpx.MockTransport(lambda req: httpx.Response(200, json={"results": nine_months}))
    )
    fetcher = WordstatFetcher(
        folder_id="b1gtestfolder",
        token_getter=lambda: "iam-token-mock",
        store=store,
        run_id="run_monthly_9pts",
        run_date="2026-11-09",
        http_client=client,
        sleeper=lambda _: None,
    )
    dyn = fetcher.getDynamics(
        phrase="вакуумные пакеты для одежды",
        from_date="2026-01-01",
        to_date="2026-10-31",
        period="monthly",
    )
    assert dyn.returnedPointsCount == 9
    assert dyn.sourceAsOf == "2026-09-01"
    assert dyn.hasTrailingGap is True
    assert all(p.date != "2026-10-01" for p in dyn.results)


def test_lagging_week_2026_09_28_and_terminated_direction_and_tpms_and_associations(tmp_path: Path) -> None:
    analyzer = OzonWordstatAnalyzer(config=DEFAULT_CONFIG, run_date="2026-11-09")

    terminated_obs = analyzer.analyze_keyword(
        phrase="термобелье женское",
        zh_draft="女士保暖内衣 [草稿]",
        category="apparel",
        seed_status="historical_test",
        requested_from="2025-11-03",
        requested_to="2026-11-08",
        top_resp=None,
        dynamics_resp=None,
        regions_resp=None,
    )
    assert terminated_obs.disposition == "blocked_terminated_direction"
    assert terminated_obs.score.observationPriorityScore is None

    heater_obs = analyzer.analyze_keyword(
        phrase="обогрев зеркал автомобиля 12в",
        zh_draft="后视镜加热垫 [草稿]",
        category="car_accessories",
        seed_status="historical_test",
        requested_from="2025-11-03",
        requested_to="2026-11-08",
        top_resp=None,
        dynamics_resp=None,
        regions_resp=None,
    )
    assert heater_obs.disposition == "blocked_terminated_direction"

    tpms_obs = analyzer.analyze_keyword(
        phrase="датчики давления в шинах tpms",
        zh_draft="胎压监测传感器 [草稿]",
        category="car_accessories",
        seed_status="portfolio_test",
        requested_from="2025-11-03",
        requested_to="2026-11-08",
        top_resp=None,
        dynamics_resp=None,
        regions_resp=None,
    )
    assert tpms_obs.disposition == "excluded_existing_portfolio"
    assert tpms_obs.score.observationPriorityScore is None

    store = VerifiedWordstatStore(LocalDirectoryStorageBackend(tmp_path))
    rows_48_lagging = _build_weekly_points("2026-09-28", weeks=48, base=6200)

    def mock_api(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if url.endswith("/topRequests"):
            return httpx.Response(
                200,
                json={
                    "totalCount": "9500",
                    "results": [{"phrase": "вакуумные пакеты для одежды", "count": "7500"}],
                    "associations": [{"phrase": "коробка икеа для переезда", "count": "4200"}],
                },
            )
        if url.endswith("/dynamics"):
            return httpx.Response(200, json={"results": rows_48_lagging})
        return httpx.Response(
            200,
            json={
                "results": [
                    {"region": "213", "count": "2100", "share": 0.281, "affinityIndex": 158.787},
                    {"region": "2", "count": "980", "share": 0.131, "affinityIndex": 169.973},
                    {"region": "54", "count": "310", "share": 0.041, "affinityIndex": 140.861},
                ]
            },
        )

    fetcher = WordstatFetcher(
        folder_id="b1gtestfolder",
        token_getter=lambda: "iam-token-mock",
        store=store,
        run_id="run_lag_48",
        run_date="2026-11-09",
        city_meta_by_id={213: {"nameRu": "Москва", "nameZh": "莫斯科"}, 2: {"nameRu": "Санкт-Петербург", "nameZh": "圣彼得堡"}, 54: {"nameRu": "Екатеринбург", "nameZh": "叶卡捷琳堡"}},
        http_client=httpx.Client(transport=httpx.MockTransport(mock_api)),
        sleeper=lambda _: None,
    )
    t_resp = fetcher.getTop("вакуумные пакеты для одежды", [225], ["all"])
    d_resp = fetcher.getDynamics("вакуумные пакеты для одежды", "2025-11-03", "2026-11-08", period="weekly")
    r_resp = fetcher.getRegionsDistribution("вакуумные пакеты для одежды", region_type="cities")

    obs = analyzer.analyze_keyword(
        phrase="вакуумные пакеты для одежды",
        zh_draft="衣物真空压缩收纳袋 [草稿]",
        category="home_storage",
        seed_status="verified_seed_for_observation",
        requested_from="2025-11-03",
        requested_to="2026-11-08",
        top_resp=t_resp,
        dynamics_resp=d_resp,
        regions_resp=r_resp,
    )
    assert d_resp.returnedPointsCount == 48
    assert obs.sourceAsOf == "2026-09-28"
    assert obs.freshnessStatus == "stale_expired"
    assert obs.score.freshnessFactor == 0.0
    assert obs.score.observationPriorityScore is None
    assert len(obs.expansionAssociations) == 1
    assert obs.referenceCities[0].affinityIndex == pytest.approx(158.787)


def test_brand_watch_vs_noise_and_missing_week_gap() -> None:
    analyzer = OzonWordstatAnalyzer(config=DEFAULT_CONFIG, run_date="2026-11-09")
    brand_obs = analyzer.analyze_keyword(
        phrase="органайзер для белья икеа",
        zh_draft="宜家风格内衣收纳盒 [草稿]",
        category="home_storage",
        seed_status="pending_verification_example",
        requested_from="2025-11-03",
        requested_to="2026-11-08",
        top_resp=None,
        dynamics_resp=None,
        regions_resp=None,
    )
    assert brand_obs.disposition == "eligible_observation"
    assert "икеа" in brand_obs.brandRiskFlags
    assert "不直接等同于法律侵权结论" in (brand_obs.brandLegalNote or "")
    assert "严禁未经授权" in (brand_obs.brandLegalNote or "")

    noise_obs = analyzer.analyze_keyword(
        phrase="полка для обуви своими руками",
        zh_draft="手工自制鞋架 [草稿]",
        category="home_storage",
        seed_status="pending_verification_example",
        requested_from="2025-11-03",
        requested_to="2026-11-08",
        top_resp=None,
        dynamics_resp=None,
        regions_resp=None,
    )
    assert noise_obs.disposition == "filtered_non_purchase_noise"


def test_corrupted_readback_hash_aborts_and_preserves_previous_report(tmp_path: Path) -> None:
    class TamperingBackend(LocalDirectoryStorageBackend):
        def __init__(self, root_dir: Path) -> None:
            super().__init__(root_dir)
            self.tamper_reports = False

        def get_bytes(self, key: str) -> bytes | None:
            raw = super().get_bytes(key)
            if raw is not None and self.tamper_reports and "/report_" in key:
                return raw + b" "
            return raw

    backend = TamperingBackend(tmp_path)
    store = VerifiedWordstatStore(backend)
    mini_cfg = dict(DEFAULT_CONFIG)
    mini_cfg["seedPhrases"] = [DEFAULT_CONFIG["seedPhrases"][0]]

    def ok_api(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if url.endswith("/topRequests"):
            return httpx.Response(200, json={"totalCount": "5000", "results": [{"phrase": "вакуумные пакеты для одежды", "count": "4500"}], "associations": []})
        if url.endswith("/dynamics"):
            return httpx.Response(200, json={"results": _build_weekly_points("2026-11-02", weeks=48, base=4500)})
        return httpx.Response(200, json={"results": [{"region": "213", "count": "1500", "share": 0.31, "affinityIndex": 155.0}]})

    client = httpx.Client(transport=httpx.MockTransport(ok_api))
    res1 = execute_weekly_pipeline(
        config=mini_cfg,
        store=store,
        folder_id="b1gtestfolder",
        token_getter=lambda: "iam-mock",
        event_id="evt-week1-ok",
        run_date_str="2026-11-09",
        dry_run=True,
        http_client=client,
    )
    assert res1["overallStatus"] == "success"
    manifest_before = store.read_json("reports/v1/manifest_latest_global.json")
    assert manifest_before is not None

    dup_res = execute_weekly_pipeline(
        config=mini_cfg,
        store=store,
        folder_id="b1gtestfolder",
        token_getter=lambda: "iam-mock",
        event_id="evt-week1-ok",
        run_date_str="2026-11-09",
        dry_run=True,
        http_client=client,
    )
    assert dup_res["skippedDuplicateEvent"] is True

    backend.tamper_reports = True
    with pytest.raises(StorageIntegrityError):
        execute_weekly_pipeline(
            config=mini_cfg,
            store=store,
            folder_id="b1gtestfolder",
            token_getter=lambda: "iam-mock",
            event_id="evt-week1-tampered",
            run_date_str="2026-11-09",
            dry_run=True,
            http_client=client,
        )

    manifest_after = store.read_json("reports/v1/manifest_latest_global.json")
    assert manifest_after == manifest_before


def test_deploy_script_pins_non_latest_tag_and_utc_monday_cron() -> None:
    deploy_sh = (PROJECT_DIR / "deploy" / "yc_deploy_and_bind_timer.sh").read_text(encoding="utf-8")
    assert 'CRON_EXPRESSION="0 1 ? * MON *"' in deploy_sh
    assert "--action" in deploy_sh
    assert '"invokeFunction"' in deploy_sh
    assert '"retryPolicy"' in deploy_sh
    assert "trigger v2 create timer" in deploy_sh
    assert "BIND_EXISTING_VERSION_ONLY" in deploy_sh
    assert "固定标签必须唯一对应现有版本" in deploy_sh
    assert "严禁将生产 Timer 直接绑定到未经验证的" in deploy_sh
    assert "functions.functionInvoker" in deploy_sh


def test_fetcher_uses_region_field_and_rfc3339_window(tmp_path: Path) -> None:
    requests: List[Dict[str, Any]] = []

    def api(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content.decode("utf-8")))
        if str(request.url).endswith("/dynamics"):
            return httpx.Response(200, json={"results": [{"date": "2026-11-02T00:00:00Z", "count": "100"}]})
        return httpx.Response(200, json={"results": []})

    fetcher = WordstatFetcher(
        folder_id="b1gtestfolder",
        token_getter=lambda: "iam-token-mock",
        store=VerifiedWordstatStore(LocalDirectoryStorageBackend(tmp_path)),
        run_id="run_contract",
        run_date="2026-11-09",
        http_client=httpx.Client(transport=httpx.MockTransport(api)),
        sleeper=lambda _: None,
    )
    fetcher.getDynamics("вакуумные пакеты для одежды", "2025-11-03", "2026-11-08", period="weekly")
    fetcher.getRegionsDistribution("вакуумные пакеты для одежды", region_type="cities")
    assert requests[0]["fromDate"] == "2025-11-03T00:00:00Z"
    assert requests[0]["toDate"] == "2026-11-08T00:00:00Z"
    assert requests[1]["region"] == "REGION_CITIES"
    assert "regionType" not in requests[1]


def test_failed_event_does_not_repeat_upstream_request(tmp_path: Path) -> None:
    calls = {"count": 0}

    def forbidden(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(403, json={"message": "Permission denied"})

    config = dict(DEFAULT_CONFIG)
    config["seedPhrases"] = [DEFAULT_CONFIG["seedPhrases"][0]]
    store = VerifiedWordstatStore(LocalDirectoryStorageBackend(tmp_path))
    client = httpx.Client(transport=httpx.MockTransport(forbidden))
    first = execute_weekly_pipeline(
        config=config,
        store=store,
        folder_id="b1gtestfolder",
        token_getter=lambda: "iam-token-mock",
        event_id="failed-event",
        run_date_str="2026-11-09",
        http_client=client,
    )
    assert first["statusCode"] == 500
    assert store.read_json("reports/v1/manifest_latest_attempt.json")["overallStatus"] == "failed_alert_only"
    assert store.read_json("reports/v1/manifest_latest_global.json") is None
    second = execute_weekly_pipeline(
        config=config,
        store=store,
        folder_id="b1gtestfolder",
        token_getter=lambda: "iam-token-mock",
        event_id="failed-event",
        run_date_str="2026-11-09",
        http_client=client,
    )
    assert second["statusCode"] == 409
    assert second["reviewRequiredBeforeRetry"] is True
    assert second["upstreamRequestsSent"] is False
    assert calls["count"] == 1


def test_timer_nested_event_id_is_used(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import src.index as index

    monkeypatch.setenv("WORDSTAT_STORAGE_BACKEND", "local")
    monkeypatch.setenv("WORDSTAT_LOCAL_STORAGE_DIR", str(tmp_path))
    monkeypatch.setenv("WORDSTAT_CONFIG_PATH", str(PROJECT_DIR / "config.yaml"))
    monkeypatch.setenv("YANDEX_CLOUD_FOLDER_ID", "b1gtestfolder")
    monkeypatch.delenv("WORDSTAT_OVERRIDE_RUN_DATE", raising=False)
    with mock.patch.object(index, "execute_weekly_pipeline", return_value={"statusCode": 200}) as execute:
        result = index.handler({"messages": [{"event_metadata": {"event_id": "timer-nested-123"}}]}, None)
    assert result["statusCode"] == 200
    assert execute.call_args.kwargs["event_id"] == "timer-nested-123"


def test_local_dry_run_is_fully_offline(tmp_path: Path) -> None:
    env = os.environ.copy()
    for key in ["YANDEX_API_KEY", "YC_SERVICE_ACCOUNT_KEY_JSON", "NOTIFY_FEISHU_WEBHOOK", "NOTIFY_FEISHU_SECRET"]:
        env.pop(key, None)
    output = tmp_path / "offline-output.json"
    result = subprocess.run(
        [sys.executable, "main.py", "--dry-run", "--event-id", "offline-test", "--local-store", str(tmp_path / "store"), "--output-json", str(output)],
        cwd=PROJECT_DIR,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["offlineFixture"] is True
    assert "OFFLINE_DRY_RUN_ONLY" in result.stdout
    assert "feishuSent\": false" in result.stdout or '"feishuSent": false' in result.stdout


def test_weekly_request_uses_complete_monday_sunday_windows(tmp_path: Path) -> None:
    from src.index import OfflineFixtureClient

    config = dict(DEFAULT_CONFIG)
    config["seedPhrases"] = [DEFAULT_CONFIG["seedPhrases"][0]]
    store = VerifiedWordstatStore(LocalDirectoryStorageBackend(tmp_path))
    result = execute_weekly_pipeline(
        config=config,
        store=store,
        folder_id="b1gtestfolder",
        token_getter=lambda: "offline-not-a-credential",
        event_id="monday-sunday-contract",
        run_date_str="2026-11-14",
        http_client=OfflineFixtureClient("2026-11-14"),
    )
    report_key = result["reportStorageKey"].removeprefix("wordstat-weekly/")
    report = store.read_json(report_key)
    dynamics_key = next(key for key in report["rawReceiptKeys"] if "/dynamics_" in key).removeprefix("wordstat-weekly/")
    envelope = store.read_json(dynamics_key)
    assert envelope["requestPayload"]["fromDate"] == "2025-11-03T00:00:00Z"
    assert envelope["requestPayload"]["toDate"] == "2026-11-08T00:00:00Z"


def test_local_storage_rejects_parent_traversal(tmp_path: Path) -> None:
    backend = LocalDirectoryStorageBackend(tmp_path / "store")
    with pytest.raises(ValueError):
        backend.get_bytes("../outside.json")


def test_storage_probe_requires_explicit_operation_and_verifies_readback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import src.storage_probe as probe

    monkeypatch.setenv("WORDSTAT_BUCKET_NAME", "onzo-test-bucket")
    backend = LocalDirectoryStorageBackend(tmp_path)
    with mock.patch.object(probe, "YandexIamObjectStorageBackend", return_value=backend), mock.patch.object(probe, "MetadataIamTokenProvider") as iam:
        iam.return_value.get_token.return_value = "offline-not-a-credential"
        with pytest.raises(ValueError):
            probe.handler({"messages": [{"event_metadata": {"event_id": "timer-not-a-probe"}}]}, None)
        result = probe.handler({"operation": "verify_storage_readback", "probeId": "storage-probe-001"}, None)
    assert result["status"] == "STORAGE_READBACK_VERIFIED"
    assert result["wordstatRequestsSent"] is False
    assert result["feishuSent"] is False
    saved = json.loads((tmp_path / "wordstat-weekly-probe/readback/storage-probe-001.json").read_text(encoding="utf-8"))
    assert saved["probeId"] == "storage-probe-001"
    assert saved["wordstatRequestsSent"] is False


def test_top_result_expansion_respects_governance_and_never_expands_associations(tmp_path: Path) -> None:
    from src.index import OfflineFixtureClient, OfflineResponse

    class ExpansionFixtureClient(OfflineFixtureClient):
        def __init__(self, run_date: str):
            super().__init__(run_date)
            self.calls: List[Dict[str, Any]] = []

        def post(self, url: str, json: Dict[str, Any], headers: Dict[str, str]):
            self.calls.append({"url": url, "body": json})
            if url.endswith("/topRequests"):
                return OfflineResponse({
                    "totalCount": "4",
                    "results": [
                        {"phrase": json["phrase"], "count": "1200"},
                        {"phrase": "вакуумные пакеты для переезда", "count": "1100"},
                        {"phrase": "датчик давления в шинах", "count": "900"},
                        {"phrase": "вакуумные пакеты ikea", "count": "800"},
                    ],
                    "associations": [{"phrase": "когтеточка для кошек", "count": "5000"}],
                })
            return super().post(url, json, headers)

    config = dict(DEFAULT_CONFIG)
    config["seedPhrases"] = [DEFAULT_CONFIG["seedPhrases"][0]]
    client = ExpansionFixtureClient("2026-11-14")
    store = VerifiedWordstatStore(LocalDirectoryStorageBackend(tmp_path))
    result = execute_weekly_pipeline(
        config=config,
        store=store,
        folder_id="b1gtestfolder",
        token_getter=lambda: "offline-not-a-credential",
        event_id="top-expansion-governance",
        run_date_str="2026-11-14",
        http_client=client,
    )
    report = store.read_json(result["reportStorageKey"].removeprefix("wordstat-weekly/"))
    expanded = [item for item in report["allEvaluatedObservations"] if item["phrase"] == "вакуумные пакеты для переезда"]
    assert len(expanded) == 1
    assert expanded[0]["seedStatus"] == "top_result_expansion_requires_seller_verification"
    assert [item["phrase"] for item in report["blockedOrExcludedItems"]] == ["датчик давления в шинах", "вакуумные пакеты ikea"]
    assert not any(call["body"]["phrase"] == "когтеточка для кошек" for call in client.calls)
    assert result["upstreamRequestCount"] == 7
    assert len(report["rawReceiptKeys"]) == 7


def test_daily_gap_fill_preserves_actual_watermark_and_missing_dates(tmp_path: Path) -> None:
    from src.daily_gap import fill_daily_gap
    from src.models import WordstatDynamicsPoint, WordstatDynamicsResponseNormalized

    weekly = WordstatDynamicsResponseNormalized(
        phrase="вакуумные пакеты для одежды",
        caliber="weekly_plus_only",
        period="weekly",
        operatorMode="plus_only_weekly",
        regions=[225],
        devices=["all"],
        fromDate="2025-11-03",
        toDate="2026-11-08",
        capturedAt="2026-11-14T00:00:00+00:00",
        sourceAsOf="2026-09-28",
        results=[WordstatDynamicsPoint(date="2026-09-28", count=1457)],
    )
    daily_points = [
        {"date": f"2026-10-{day:02d}T00:00:00Z", "count": "200", "share": 0.001}
        for day in range(5, 10)
    ]
    requests: List[Dict[str, Any]] = []

    def daily_api(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content.decode("utf-8")))
        return httpx.Response(200, json={"results": daily_points})

    fetcher = WordstatFetcher(
        folder_id="b1gtestfolder",
        token_getter=lambda: "offline-not-a-credential",
        store=VerifiedWordstatStore(LocalDirectoryStorageBackend(tmp_path)),
        run_id="daily-gap-test",
        run_date="2026-11-14",
        http_client=httpx.Client(transport=httpx.MockTransport(daily_api)),
        sleeper=lambda _: None,
    )
    result = fill_daily_gap(fetcher, weekly, "2026-11-14")
    assert result.sourceAsOf == "2026-10-09"
    assert result.returnedPointsCount == 5
    assert result.targetThroughDate == "2026-11-13"
    assert result.missingFromDate == "2026-10-10"
    assert result.missingCalendarDays == 35
    assert result.status == "partial"
    assert requests[0]["fromDate"] == "2026-10-05T00:00:00Z"
    assert requests[0]["toDate"] == "2026-11-03T00:00:00Z"
    assert weekly.results[0].count == 1457


def test_daily_gap_rejection_does_not_fill_zero_or_retry(tmp_path: Path) -> None:
    from src.daily_gap import fill_daily_gap
    from src.models import WordstatDynamicsPoint, WordstatDynamicsResponseNormalized

    weekly = WordstatDynamicsResponseNormalized(
        phrase="вакуумные пакеты для одежды",
        caliber="weekly_plus_only",
        period="weekly",
        operatorMode="plus_only_weekly",
        regions=[225],
        devices=["all"],
        fromDate="2025-11-03",
        toDate="2026-11-08",
        capturedAt="2026-11-14T00:00:00+00:00",
        sourceAsOf="2026-09-28",
        results=[WordstatDynamicsPoint(date="2026-09-28", count=1457)],
    )
    calls = {"count": 0}

    def reject(_request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(400, json={"message": "Bad Request"})

    fetcher = WordstatFetcher(
        folder_id="b1gtestfolder",
        token_getter=lambda: "offline-not-a-credential",
        store=VerifiedWordstatStore(LocalDirectoryStorageBackend(tmp_path)),
        run_id="daily-gap-reject",
        run_date="2026-11-14",
        http_client=httpx.Client(transport=httpx.MockTransport(reject)),
        sleeper=lambda _: None,
    )
    result = fill_daily_gap(fetcher, weekly, "2026-11-14")
    assert result.status == "request_failed"
    assert result.sourceAsOf is None
    assert result.returnedPointsCount == 0
    assert result.missingCalendarDays == 40
    assert result.requestFailed is True
    assert calls["count"] == 1


def test_watermark_daily_probe_skips_duplicates_and_preserves_revision_history(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from src.index import OfflineFixtureClient, handler

    class CountingFixture(OfflineFixtureClient):
        def __init__(self, run_date: str):
            super().__init__(run_date)
            self.calls = 0

        def post(self, url: str, json: Dict[str, Any], headers: Dict[str, str]):
            self.calls += 1
            return super().post(url, json, headers)

    monkeypatch.setenv("WORDSTAT_STORAGE_BACKEND", "local")
    monkeypatch.setenv("WORDSTAT_LOCAL_STORAGE_DIR", str(tmp_path))
    monkeypatch.setenv("YANDEX_CLOUD_FOLDER_ID", "b1gtestfolder")
    monkeypatch.setenv("WORDSTAT_OVERRIDE_RUN_DATE", "2026-11-14")
    client = CountingFixture("2026-11-14")
    context = {"offlineHttpClient": client}
    monkeypatch.setattr("src.watermark.MetadataIamTokenProvider.get_token", lambda self: "offline-not-a-credential")

    def invoke(event_id: str):
        return handler({"messages": [{"event_metadata": {"event_id": event_id}, "payload": "wordstat-watermark"}]}, context)

    first = invoke("watermark-first")
    assert first["status"] == "FULL_REPORT_GENERATED"
    assert first["sourceAsOf"] == "2026-11-02"
    assert len(first["responseHash"]) == 64
    store = VerifiedWordstatStore(LocalDirectoryStorageBackend(tmp_path))
    first_watermark = store.read_json("watermark/latest.json")
    first_report = store.read_json(first_watermark["lastReportStorageKey"].removeprefix("wordstat-weekly/"))
    assert first_report["latestDailySourceAsOf"] == "2026-11-13"
    assert first_report["allEvaluatedObservations"][0]["dailyGapFill"]["status"] == "complete"
    calls_after_first = client.calls

    duplicate = invoke("watermark-first")
    assert duplicate["skippedDuplicateEvent"] is True
    assert duplicate["upstreamRequestsSent"] is False
    assert client.calls == calls_after_first

    unchanged = invoke("watermark-unchanged")
    assert unchanged["status"] == "NO_UPSTREAM_CHANGE"
    assert unchanged["fullReport"] is None
    assert client.calls == calls_after_first + 1

    client.points[-1]["count"] = "9999"
    revised = invoke("watermark-revised")
    assert revised["status"] == "FULL_REPORT_GENERATED"
    assert revised["triggerReason"] == "historical_revision"
    revised_watermark = store.read_json("watermark/latest.json")
    revised_report = store.read_json(revised_watermark["lastReportStorageKey"].removeprefix("wordstat-weekly/"))
    assert revised_report["idempotencyKey"] != first_report["idempotencyKey"]
    assert store.read_json(first_watermark["lastReportStorageKey"].removeprefix("wordstat-weekly/")) == first_report


def test_daily_gap_failure_does_not_fail_valid_primary_weekly_receipt(tmp_path: Path) -> None:
    config = dict(DEFAULT_CONFIG)
    config["seedPhrases"] = [DEFAULT_CONFIG["seedPhrases"][0]]

    def api(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        if str(request.url).endswith("/topRequests"):
            return httpx.Response(200, json={"totalCount": "1000", "results": [{"phrase": body["phrase"], "count": "1000"}], "associations": []})
        if str(request.url).endswith("/regions"):
            return httpx.Response(200, json={"results": []})
        if body.get("period") == "PERIOD_DAILY":
            return httpx.Response(400, json={"message": "Bad Request"})
        return httpx.Response(200, json={"results": _build_weekly_points("2026-09-28", weeks=48)})

    store = VerifiedWordstatStore(LocalDirectoryStorageBackend(tmp_path))
    result = execute_weekly_pipeline(
        config=config,
        store=store,
        folder_id="b1gtestfolder",
        token_getter=lambda: "offline-not-a-credential",
        event_id="daily-gap-is-partial",
        run_date_str="2026-11-14",
        http_client=httpx.Client(transport=httpx.MockTransport(api)),
    )
    assert result["statusCode"] == 200
    assert result["overallStatus"] == "degraded_partial"
    saved = store.read_json(result["reportStorageKey"].removeprefix("wordstat-weekly/"))
    assert saved["failedRequests"][0]["stage"] == "daily_gap"
    assert saved["allEvaluatedObservations"][0]["score"]["observationPriorityScore"] is None
    assert saved["allEvaluatedObservations"][0]["dailyGapFill"]["sourceAsOf"] is None
    assert store.get_event_ledger("daily-gap-is-partial")["status"] == "COMPLETED"
