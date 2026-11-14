from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import re
import time
from typing import Any, Callable, Dict, List, Literal, Optional
import httpx

from src import ALGO_VERSION, SCHEMA_VERSION
from src.models import (
    FailedRequestDiagnostic,
    RawReceiptEnvelope,
    WordstatDynamicsPoint,
    WordstatDynamicsResponseNormalized,
    WordstatRegionItem,
    WordstatRegionsResponseNormalized,
    WordstatTopItem,
    WordstatTopResponseNormalized,
)
from src.storage_ledger import VerifiedWordstatStore

STRICT_DAILY_OPERATOR_PATTERN = re.compile(r'["!()|]|(?:^|\s)-[а-яА-ЯёЁa-zA-Z0-9]')

DEVICE_ENUM_MAP = {
    "all": "DEVICE_ALL",
    "desktop": "DEVICE_DESKTOP",
    "phone": "DEVICE_PHONE",
    "tablet": "DEVICE_TABLET",
    "DEVICE_ALL": "DEVICE_ALL",
    "DEVICE_DESKTOP": "DEVICE_DESKTOP",
    "DEVICE_PHONE": "DEVICE_PHONE",
    "DEVICE_TABLET": "DEVICE_TABLET",
}

PERIOD_ENUM_MAP = {
    "weekly": "PERIOD_WEEKLY",
    "monthly": "PERIOD_MONTHLY",
    "daily": "PERIOD_DAILY",
}

REGION_TYPE_ENUM_MAP = {
    "cities": "REGION_CITIES",
    "regions": "REGION_REGIONS",
    "all": "REGION_ALL",
    "REGION_CITIES": "REGION_CITIES",
    "REGION_REGIONS": "REGION_REGIONS",
    "REGION_ALL": "REGION_ALL",
}


class QuotaBudgetExhaustedError(RuntimeError):
    pass


class WordstatPermissionDeniedError(RuntimeError):
    pass


class OutcomeUnknownHaltedError(RuntimeError):
    pass


class WordstatUpstreamError(RuntimeError):
    pass


def has_non_plus_special_operators(phrase: str) -> bool:
    return bool(STRICT_DAILY_OPERATOR_PATTERN.search(phrase.strip()))


def validate_monthly_window_dates(from_date_str: str, to_date_str: str) -> None:
    f_dt = date.fromisoformat(from_date_str)
    t_dt = date.fromisoformat(to_date_str)
    if f_dt.day != 1:
        raise ValueError(f"月度 dynamics 请求 fromDate 必须为自然月第一天，当前为: {from_date_str}")
    expected_last_day = calendar.monthrange(t_dt.year, t_dt.month)[1]
    if t_dt.day != expected_last_day:
        raise ValueError(
            f"月度 dynamics 请求 toDate 必须为该月最后一天 ({t_dt.year}-{t_dt.month:02d}-{expected_last_day:02d})，当前为: {to_date_str}"
        )
    if t_dt < f_dt:
        raise ValueError(f"toDate ({to_date_str}) 不能早于 fromDate ({from_date_str})")


class WordstatFetcher:
    def __init__(
        self,
        folder_id: str,
        token_getter: Callable[[], str],
        store: VerifiedWordstatStore,
        run_id: str,
        run_date: str,
        base_url: str = "https://searchapi.api.cloud.yandex.net/v2/wordstat",
        translate_url: str = "https://translate.api.cloud.yandex.net/translate/v2/translate",
        max_rps: float = 5.0,
        daily_budget: int = 600,
        timeout_seconds: float = 15.0,
        max_retries_429: int = 3,
        max_retries_503: int = 2,
        unknown_outcome_cooldown_seconds: float = 3.0,
        max_unknown_outcome_probes: int = 1,
        city_meta_by_id: Optional[Dict[int, Dict[str, str]]] = None,
        http_client: Optional[httpx.Client] = None,
        sleeper: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not folder_id:
            raise ValueError("YANDEX_CLOUD_FOLDER_ID 不能为空")
        self.folder_id = folder_id
        self.token_getter = token_getter
        self.store = store
        self.run_id = run_id
        self.run_date = run_date
        self.base_url = base_url.rstrip("/")
        self.translate_url = translate_url
        self.min_interval = 1.0 / max(max_rps, 0.1)
        self.daily_budget = daily_budget
        self.max_retries_429 = max_retries_429
        self.max_retries_503 = max_retries_503
        self.unknown_outcome_cooldown_seconds = unknown_outcome_cooldown_seconds
        self.max_unknown_outcome_probes = max_unknown_outcome_probes
        self.city_meta_by_id = city_meta_by_id or {}
        self.client = http_client or httpx.Client(timeout=timeout_seconds)
        self._sleep = sleeper
        self._clock = clock
        self._last_request_ts: Optional[float] = None
        self.raw_receipt_keys: List[str] = []
        self.failed_diagnostics: List[FailedRequestDiagnostic] = []

    @staticmethod
    def _utc_now_iso() -> str:
        return datetime.now(timezone.utc).replace(microsecond=0).isoformat()

    def _throttle(self) -> None:
        now = self._clock()
        if self._last_request_ts is not None:
            elapsed = now - self._last_request_ts
            if elapsed < self.min_interval:
                self._sleep(self.min_interval - elapsed)
        self._last_request_ts = self._clock()

    @staticmethod
    def compute_cache_fingerprint(
        endpoint: str,
        phrase: str,
        regions: List[int],
        devices: List[str],
        operator_mode: str,
        window_params: Dict[str, Any],
    ) -> str:
        normalized_phrase = " ".join(phrase.strip().lower().replace("ё", "е").split())
        canonical = {
            "schemaVersion": SCHEMA_VERSION,
            "algoVersion": ALGO_VERSION,
            "endpoint": endpoint,
            "phrase": phrase.strip(),
            "normalizedPhrase": normalized_phrase,
            "regions": sorted(int(r) for r in regions),
            "devices": sorted(str(d) for d in devices),
            "operatorMode": operator_mode,
            "window": window_params,
        }
        blob = json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(blob).hexdigest()

    def _headers(self) -> Dict[str, str]:
        token = self.token_getter()
        return {
            "Authorization": f"Bearer {token}",
            "x-folder-id": self.folder_id,
            "Content-Type": "application/json",
        }

    @staticmethod
    def _parse_retry_after(header_val: Optional[str], fallback_seconds: float) -> float:
        if not header_val:
            return fallback_seconds
        try:
            parsed = float(header_val.strip())
            return max(0.5, min(parsed, 60.0))
        except ValueError:
            return fallback_seconds

    def _execute_wordstat_post(
        self,
        endpoint: Literal["topRequests", "dynamics", "regions"],
        phrase: str,
        cache_fingerprint: str,
        request_body: Dict[str, Any],
        source_as_of_extractor: Callable[[Dict[str, Any]], Optional[str]],
    ) -> Dict[str, Any]:
        existing_state = self.store.get_request_state(cache_fingerprint)
        if existing_state and existing_state.get("status") == "SUCCEEDED":
            raw_rel_key = existing_state.get("rawRelativeKey")
            if raw_rel_key:
                cached_envelope = self.store.read_json(raw_rel_key)
                if cached_envelope and "rawResponse" in cached_envelope:
                    full_key = f"{self.store.prefix}/{raw_rel_key}" if self.store.prefix else raw_rel_key
                    if full_key not in self.raw_receipt_keys:
                        self.raw_receipt_keys.append(full_key)
                    return cached_envelope["rawResponse"]

        unknown_probes_done = int(existing_state.get("unknownOutcomeProbes", 0)) if existing_state else 0
        if existing_state and existing_state.get("status") == "OUTCOME_UNKNOWN":
            if unknown_probes_done >= self.max_unknown_outcome_probes:
                msg = (
                    f"请求指纹 {cache_fingerprint[:12]} 处于 OUTCOME_UNKNOWN（结果不明）且已达受控探针上限 "
                    f"({self.max_unknown_outcome_probes})，禁止盲目重发以避免重复配额消耗。"
                )
                self.failed_diagnostics.append(
                    FailedRequestDiagnostic(
                        phrase=phrase,
                        endpoint=endpoint,
                        errorType="OUTCOME_UNKNOWN",
                        httpStatus=None,
                        message=msg,
                        occurredAt=self._utc_now_iso(),
                    )
                )
                raise OutcomeUnknownHaltedError(msg)
            self._sleep(self.unknown_outcome_cooldown_seconds)

        attempts_429 = 0
        attempts_503 = 0
        url = f"{self.base_url}/{endpoint}"

        while True:
            used_today = self.store.get_daily_budget_used(self.run_date)
            if used_today >= self.daily_budget:
                msg = f"已达到每日 Wordstat 请求预算上限 ({used_today}/{self.daily_budget})，触发熔断保护"
                self.failed_diagnostics.append(
                    FailedRequestDiagnostic(
                        phrase=phrase,
                        endpoint=endpoint,
                        errorType="BUDGET_EXHAUSTED",
                        httpStatus=None,
                        message=msg,
                        occurredAt=self._utc_now_iso(),
                    )
                )
                raise QuotaBudgetExhaustedError(msg)

            self._throttle()
            is_probe_after_unknown = bool(existing_state and existing_state.get("status") == "OUTCOME_UNKNOWN")
            if is_probe_after_unknown:
                unknown_probes_done += 1

            self.store.increment_daily_budget(self.run_date, delta=1, reason=f"{endpoint}:{cache_fingerprint[:10]}")

            try:
                resp = self.client.post(url, json=request_body, headers=self._headers())
            except (httpx.ReadTimeout, httpx.WriteTimeout, httpx.PoolTimeout, httpx.RemoteProtocolError, httpx.NetworkError) as exc:
                self.store.save_request_state(
                    cache_fingerprint,
                    {
                        "status": "OUTCOME_UNKNOWN",
                        "endpoint": endpoint,
                        "phrase": phrase,
                        "unknownOutcomeProbes": unknown_probes_done,
                        "lastError": f"{type(exc).__name__}: {exc}",
                        "updatedAt": self._utc_now_iso(),
                    },
                )
                msg = (
                    f"Wordstat {endpoint} 请求已发出但网络读取结果不明 ({type(exc).__name__})；"
                    "已记入 OUTCOME_UNKNOWN 账本，不直接当作普通失败无限重试。"
                )
                self.failed_diagnostics.append(
                    FailedRequestDiagnostic(
                        phrase=phrase,
                        endpoint=endpoint,
                        errorType="OUTCOME_UNKNOWN",
                        httpStatus=None,
                        message=msg,
                        occurredAt=self._utc_now_iso(),
                    )
                )
                raise OutcomeUnknownHaltedError(msg) from exc

            if resp.status_code == 200:
                raw_data = resp.json()
                captured_at = self._utc_now_iso()
                source_as_of = source_as_of_extractor(raw_data)
                raw_bytes = VerifiedWordstatStore.canonical_json_bytes(raw_data)
                raw_sha256 = VerifiedWordstatStore.sha256_hex(raw_bytes)
                raw_rel_key = f"raw/v1/{self.run_date}/{self.run_id}/{endpoint}_{cache_fingerprint}.json"

                envelope = RawReceiptEnvelope(
                    schemaVersion=SCHEMA_VERSION,
                    algoVersion=ALGO_VERSION,
                    runId=self.run_id,
                    endpoint=endpoint,
                    cacheFingerprint=cache_fingerprint,
                    requestPayload=request_body,
                    rawResponse=raw_data,
                    capturedAt=captured_at,
                    sourceAsOf=source_as_of,
                    rawPayloadSha256=raw_sha256,
                )
                full_key, _, _ = self.store.write_and_verify_model(
                    relative_key=raw_rel_key,
                    model_instance=envelope,
                    model_cls=RawReceiptEnvelope,
                    expected_source_as_of=source_as_of,
                    require_source_as_of_check=True,
                )
                self.raw_receipt_keys.append(full_key)
                self.store.save_request_state(
                    cache_fingerprint,
                    {
                        "status": "SUCCEEDED",
                        "endpoint": endpoint,
                        "phrase": phrase,
                        "rawRelativeKey": raw_rel_key,
                        "rawPayloadSha256": raw_sha256,
                        "sourceAsOf": source_as_of,
                        "updatedAt": captured_at,
                    },
                )
                return raw_data

            if resp.status_code == 403:
                msg = (
                    f"Wordstat {endpoint} 返回 HTTP 403 权限拒绝（folderId={self.folder_id}）。"
                    "请核查运行服务账号是否具备 Search API v2 最小调用角色，禁止授予管理员权限。"
                )
                self.failed_diagnostics.append(
                    FailedRequestDiagnostic(
                        phrase=phrase,
                        endpoint=endpoint,
                        errorType="PERMISSION_403",
                        httpStatus=403,
                        message=msg,
                        occurredAt=self._utc_now_iso(),
                    )
                )
                raise WordstatPermissionDeniedError(msg)

            if resp.status_code == 429:
                attempts_429 += 1
                if attempts_429 > self.max_retries_429:
                    msg = f"Wordstat {endpoint} 连续 {attempts_429} 次触发 HTTP 429 限流，停止重试"
                    self.failed_diagnostics.append(
                        FailedRequestDiagnostic(
                            phrase=phrase,
                            endpoint=endpoint,
                            errorType="RATE_LIMIT_429",
                            httpStatus=429,
                            message=msg,
                            occurredAt=self._utc_now_iso(),
                        )
                    )
                    raise WordstatUpstreamError(msg)
                wait_sec = self._parse_retry_after(resp.headers.get("Retry-After"), fallback_seconds=2.0 ** attempts_429)
                self._sleep(wait_sec)
                continue

            if resp.status_code == 503:
                attempts_503 += 1
                if attempts_503 > self.max_retries_503:
                    msg = f"Wordstat {endpoint} 连续 {attempts_503} 次返回 HTTP 503 服务暂不可用，停止重试"
                    self.failed_diagnostics.append(
                        FailedRequestDiagnostic(
                            phrase=phrase,
                            endpoint=endpoint,
                            errorType="UNAVAILABLE_503",
                            httpStatus=503,
                            message=msg,
                            occurredAt=self._utc_now_iso(),
                        )
                    )
                    raise WordstatUpstreamError(msg)
                self._sleep(1.5 * (2 ** (attempts_503 - 1)))
                continue

            msg = f"Wordstat {endpoint} 返回非预期状态码 HTTP {resp.status_code}"
            self.failed_diagnostics.append(
                FailedRequestDiagnostic(
                    phrase=phrase,
                    endpoint=endpoint,
                    errorType="OTHER_HTTP_ERROR",
                    httpStatus=resp.status_code,
                    message=msg,
                    occurredAt=self._utc_now_iso(),
                )
            )
            raise WordstatUpstreamError(msg)

    def getTop(
        self,
        phrase: str,
        regions: List[int],
        devices: List[str],
        num_phrases: int = 50,
    ) -> WordstatTopResponseNormalized:
        mapped_devices = [DEVICE_ENUM_MAP.get(d, "DEVICE_ALL") for d in devices]
        body = {
            "phrase": phrase,
            "numPhrases": num_phrases,
            "regions": [str(r) for r in regions],
            "devices": mapped_devices,
            "folderId": self.folder_id,
        }
        fp = self.compute_cache_fingerprint(
            endpoint="topRequests",
            phrase=phrase,
            regions=regions,
            devices=mapped_devices,
            operator_mode="standard_top",
            window_params={"numPhrases": num_phrases, "anchorRunDate": self.run_date},
        )
        raw = self._execute_wordstat_post(
            endpoint="topRequests",
            phrase=phrase,
            cache_fingerprint=fp,
            request_body=body,
            source_as_of_extractor=lambda _: None,
        )
        raw_results = raw.get("results") or []
        raw_assoc = raw.get("associations") or []
        total_count_raw = raw.get("totalCount")
        return WordstatTopResponseNormalized(
            phrase=phrase,
            totalCount=int(total_count_raw) if total_count_raw is not None else None,
            results=[WordstatTopItem(phrase=str(x["phrase"]), count=int(x["count"])) for x in raw_results if "phrase" in x and "count" in x],
            associations=[WordstatTopItem(phrase=str(x["phrase"]), count=int(x["count"])) for x in raw_assoc if "phrase" in x and "count" in x],
        )

    def getDynamics(
        self,
        phrase: str,
        from_date: str,
        to_date: str,
        period: Literal["weekly", "monthly", "daily"] = "weekly",
        regions: Optional[List[int]] = None,
        devices: Optional[List[str]] = None,
        strict_operator_strategy: str = "separate_daily_caliber",
        daily_strict_lookback_days: int = 30,
    ) -> WordstatDynamicsResponseNormalized:
        target_regions = regions if regions is not None else [225]
        target_devices = devices if devices is not None else ["all"]
        mapped_devices = [DEVICE_ENUM_MAP.get(d, "DEVICE_ALL") for d in target_devices]

        effective_period: Literal["weekly", "monthly", "daily"] = period
        effective_from = from_date
        effective_to = to_date
        has_strict_ops = has_non_plus_special_operators(phrase)

        if period in ("weekly", "monthly") and has_strict_ops:
            if strict_operator_strategy == "separate_daily_caliber":
                effective_period = "daily"
                end_dt = date.fromisoformat(to_date)
                start_dt = end_dt - timedelta(days=daily_strict_lookback_days)
                effective_from = start_dt.isoformat()
                operator_mode = "daily_strict_syntax_isolated"
                caliber: Literal["weekly_plus_only", "monthly_plus_only", "daily_strict_operator"] = "daily_strict_operator"
            else:
                raise ValueError(
                    f"Wordstat dynamics period={period} 仅支持 '+' 操作符，检测到精确语法词: {phrase}"
                )
        else:
            if effective_period == "monthly":
                validate_monthly_window_dates(effective_from, effective_to)
                caliber = "monthly_plus_only"
                operator_mode = "plus_only_monthly"
            elif effective_period == "weekly":
                caliber = "weekly_plus_only"
                operator_mode = "plus_only_weekly"
            else:
                caliber = "daily_strict_operator"
                operator_mode = "daily_explicit"

        body = {
            "phrase": phrase,
            "period": PERIOD_ENUM_MAP[effective_period],
            "fromDate": f"{effective_from}T00:00:00Z",
            "toDate": f"{effective_to}T00:00:00Z",
            "regions": [str(r) for r in target_regions],
            "devices": mapped_devices,
            "folderId": self.folder_id,
        }

        def _extract_last_date(payload: Dict[str, Any]) -> Optional[str]:
            rows = payload.get("results") or []
            dates = sorted(str(r["date"]) for r in rows if r.get("date"))
            return dates[-1] if dates else None

        fp = self.compute_cache_fingerprint(
            endpoint="dynamics",
            phrase=phrase,
            regions=target_regions,
            devices=mapped_devices,
            operator_mode=operator_mode,
            window_params={"period": effective_period, "fromDate": effective_from, "toDate": effective_to},
        )
        raw = self._execute_wordstat_post(
            endpoint="dynamics",
            phrase=phrase,
            cache_fingerprint=fp,
            request_body=body,
            source_as_of_extractor=_extract_last_date,
        )
        raw_rows = raw.get("results") or []
        points: List[WordstatDynamicsPoint] = []
        for row in raw_rows:
            if "date" not in row or row.get("count") is None:
                continue
            points.append(
                WordstatDynamicsPoint(
                    date=str(row["date"])[:10],
                    count=int(row["count"]),
                    share=float(row["share"]) if row.get("share") is not None else None,
                )
            )
        points.sort(key=lambda p: p.date)
        returned_dates = [str(row["date"])[:10] for row in raw_rows if row.get("date")]
        source_as_of = max(returned_dates) if returned_dates else None

        has_trailing_gap = False
        has_internal_gap = False
        if points:
            last_dt = date.fromisoformat(points[-1].date)
            req_to_dt = date.fromisoformat(effective_to)
            if effective_period == "weekly":
                has_trailing_gap = (req_to_dt - last_dt).days >= 14
                for idx in range(1, len(points)):
                    prev_dt = date.fromisoformat(points[idx - 1].date)
                    curr_dt = date.fromisoformat(points[idx].date)
                    if (curr_dt - prev_dt).days != 7:
                        has_internal_gap = True
                        break
            elif effective_period == "monthly":
                has_trailing_gap = (last_dt.year, last_dt.month) < (req_to_dt.year, req_to_dt.month)
                for idx in range(1, len(points)):
                    prev_dt = date.fromisoformat(points[idx - 1].date)
                    curr_dt = date.fromisoformat(points[idx].date)
                    month_diff = (curr_dt.year - prev_dt.year) * 12 + (curr_dt.month - prev_dt.month)
                    if month_diff != 1:
                        has_internal_gap = True
                        break

        return WordstatDynamicsResponseNormalized(
            phrase=phrase,
            caliber=caliber,
            period=effective_period,
            operatorMode=operator_mode,
            regions=target_regions,
            devices=target_devices,
            fromDate=effective_from,
            toDate=effective_to,
            capturedAt=self._utc_now_iso(),
            sourceAsOf=source_as_of,
            returnedPointsCount=len(points),
            hasTrailingGap=has_trailing_gap,
            hasInternalGap=has_internal_gap,
            results=points,
        )

    def getRegionsDistribution(
        self,
        phrase: str,
        region_type: Literal["cities", "regions", "all"] = "cities",
        devices: Optional[List[str]] = None,
    ) -> WordstatRegionsResponseNormalized:
        target_devices = devices if devices is not None else ["all"]
        mapped_devices = [DEVICE_ENUM_MAP.get(d, "DEVICE_ALL") for d in target_devices]
        mapped_region_type = REGION_TYPE_ENUM_MAP[region_type]

        body = {
            "phrase": phrase,
            "region": mapped_region_type,
            "devices": mapped_devices,
            "folderId": self.folder_id,
        }
        fp = self.compute_cache_fingerprint(
            endpoint="regions",
            phrase=phrase,
            regions=[],
            devices=mapped_devices,
            operator_mode=f"region_{region_type}",
            window_params={"regionType": mapped_region_type, "anchorRunDate": self.run_date},
        )
        raw = self._execute_wordstat_post(
            endpoint="regions",
            phrase=phrase,
            cache_fingerprint=fp,
            request_body=body,
            source_as_of_extractor=lambda _: None,
        )
        raw_rows = raw.get("results") or []
        items: List[WordstatRegionItem] = []
        for r in raw_rows:
            if "region" not in r or r.get("count") is None:
                continue
            reg_id = int(r["region"])
            meta = self.city_meta_by_id.get(reg_id, {})
            items.append(
                WordstatRegionItem(
                    region=reg_id,
                    cityNameRu=meta.get("nameRu"),
                    cityNameZh=meta.get("nameZh"),
                    count=int(r["count"]),
                    share=float(r["share"]) if r.get("share") is not None else None,
                    affinityIndex=float(r["affinityIndex"]) if r.get("affinityIndex") is not None else None,
                )
            )
        return WordstatRegionsResponseNormalized(
            phrase=phrase,
            regionType=region_type,
            devices=target_devices,
            capturedAt=self._utc_now_iso(),
            results=items,
        )

    def translateDraftsZh(self, phrases: List[str], fallback_hints: Dict[str, str], enabled: bool = True) -> Dict[str, str]:
        result: Dict[str, str] = {}
        missing: List[str] = []
        for p in phrases:
            if p in fallback_hints and fallback_hints[p].strip():
                result[p] = f"{fallback_hints[p].strip()} [草稿]"
            else:
                missing.append(p)

        if not missing or not enabled:
            for p in missing:
                result[p] = f"{p} [待人工核译草稿]"
            return result

        try:
            self._throttle()
            resp = self.client.post(
                self.translate_url,
                headers=self._headers(),
                json={
                    "folderId": self.folder_id,
                    "texts": missing,
                    "sourceLanguageCode": "ru",
                    "targetLanguageCode": "zh",
                },
            )
            if resp.status_code == 200:
                translations = resp.json().get("translations") or []
                for idx, src_phrase in enumerate(missing):
                    if idx < len(translations) and translations[idx].get("text"):
                        result[src_phrase] = f"{translations[idx]['text']} [机翻草稿]"
                    else:
                        result[src_phrase] = f"{src_phrase} [待人工核译草稿]"
                return result
        except httpx.RequestError:
            pass

        for p in missing:
            result[p] = f"{p} [待人工核译草稿]"
        return result
