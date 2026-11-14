from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Protocol, Type, TypeVar
import httpx
from pydantic import BaseModel, ValidationError

TModel = TypeVar("TModel", bound=BaseModel)


class StorageIntegrityError(RuntimeError):
    pass


class StoragePermissionError(RuntimeError):
    pass


class ObjectStorageBackend(Protocol):
    def put_bytes(self, key: str, data: bytes, content_type: str = "application/json") -> None:
        ...

    def get_bytes(self, key: str) -> Optional[bytes]:
        ...


class LocalDirectoryStorageBackend:
    def __init__(self, root_dir: str | Path) -> None:
        self.root = Path(root_dir)
        self.root.mkdir(parents=True, exist_ok=True)

    def _resolve(self, key: str) -> Path:
        clean_key = key.lstrip("/")
        target = (self.root / clean_key).resolve()
        if not target.is_relative_to(self.root.resolve()):
            raise ValueError(f"非法存储路径越界: {key}")
        return target

    def put_bytes(self, key: str, data: bytes, content_type: str = "application/json") -> None:
        target = self._resolve(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    def get_bytes(self, key: str) -> Optional[bytes]:
        target = self._resolve(key)
        if not target.exists():
            return None
        return target.read_bytes()


class YandexIamObjectStorageBackend:
    """使用 Yandex Object Storage 原生 X-YaCloud-SubjectToken (Metadata IAM) 读写对象，无需复制静态 S3 密钥到云函数。"""

    def __init__(
        self,
        bucket_name: str,
        token_getter: Callable[[], str],
        endpoint_url: str = "https://storage.yandexcloud.net",
        http_client: Optional[httpx.Client] = None,
    ) -> None:
        if not bucket_name:
            raise ValueError("WORDSTAT_BUCKET_NAME 不能为空")
        self.bucket_name = bucket_name
        self.token_getter = token_getter
        self.endpoint_url = endpoint_url.rstrip("/")
        self.client = http_client or httpx.Client(timeout=20.0)

    def _url(self, key: str) -> str:
        clean_key = key.lstrip("/")
        return f"{self.endpoint_url}/{self.bucket_name}/{clean_key}"

    def put_bytes(self, key: str, data: bytes, content_type: str = "application/json") -> None:
        token = self.token_getter()
        resp = self.client.put(
            self._url(key),
            content=data,
            headers={
                "X-YaCloud-SubjectToken": token,
                "Content-Type": content_type,
            },
        )
        if resp.status_code == 403:
            raise StoragePermissionError(
                f"Object Storage PUT 权限不足 (HTTP 403): bucket={self.bucket_name}, key={key}。"
                "请仅为运行服务账号授予目标 Bucket 的最小对象写入/回读角色，切勿授予管理员权限。"
            )
        if resp.status_code not in (200, 201):
            raise StorageIntegrityError(
                f"Object Storage PUT 失败: HTTP {resp.status_code}, key={key}"
            )

    def get_bytes(self, key: str) -> Optional[bytes]:
        token = self.token_getter()
        resp = self.client.get(
            self._url(key),
            headers={"X-YaCloud-SubjectToken": token},
        )
        if resp.status_code == 404:
            return None
        if resp.status_code == 403:
            raise StoragePermissionError(
                f"Object Storage GET 回读权限不足 (HTTP 403): bucket={self.bucket_name}, key={key}"
            )
        if resp.status_code != 200:
            raise StorageIntegrityError(
                f"Object Storage GET 回读失败: HTTP {resp.status_code}, key={key}"
            )
        return resp.content


class VerifiedWordstatStore:
    def __init__(self, backend: ObjectStorageBackend, prefix: str = "wordstat-weekly") -> None:
        self.backend = backend
        self.prefix = prefix.strip("/")

    def _full_key(self, relative_key: str) -> str:
        rel = relative_key.lstrip("/")
        return f"{self.prefix}/{rel}" if self.prefix else rel

    @staticmethod
    def canonical_json_bytes(payload: Any) -> bytes:
        return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")

    @staticmethod
    def sha256_hex(data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()

    def write_and_verify_model(
        self,
        relative_key: str,
        model_instance: TModel,
        model_cls: Type[TModel],
        expected_source_as_of: Optional[str] = None,
        require_source_as_of_check: bool = False,
    ) -> tuple[str, str, int]:
        full_key = self._full_key(relative_key)
        payload_dict = model_instance.model_dump(mode="json")
        expected_bytes = self.canonical_json_bytes(payload_dict)
        expected_len = len(expected_bytes)
        expected_sha = self.sha256_hex(expected_bytes)

        self.backend.put_bytes(full_key, expected_bytes)
        readback_bytes = self.backend.get_bytes(full_key)
        if readback_bytes is None:
            raise StorageIntegrityError(f"写入后云端回读为空 (404): {full_key}")

        actual_len = len(readback_bytes)
        actual_sha = self.sha256_hex(readback_bytes)
        if actual_len != expected_len or actual_sha != expected_sha:
            raise StorageIntegrityError(
                f"云端回读完整性校验失败 ({full_key}): "
                f"expected_len={expected_len}, actual_len={actual_len}, "
                f"expected_sha={expected_sha}, actual_sha={actual_sha}"
            )

        try:
            validated = model_cls.model_validate_json(readback_bytes)
        except ValidationError as exc:
            raise StorageIntegrityError(f"云端回读 Schema 校验失败 ({full_key}): {exc}") from exc

        if require_source_as_of_check:
            actual_as_of = getattr(validated, "sourceAsOf", None) or getattr(validated, "globalSourceAsOfMax", None)
            if actual_as_of != expected_source_as_of:
                raise StorageIntegrityError(
                    f"云端回读实际最后数据日期不一致 ({full_key}): expected={expected_source_as_of}, actual={actual_as_of}"
                )

        return full_key, actual_sha, actual_len

    def read_json(self, relative_key: str) -> Optional[Dict[str, Any]]:
        raw = self.backend.get_bytes(self._full_key(relative_key))
        if raw is None:
            return None
        return json.loads(raw.decode("utf-8"))

    def write_json_verified(self, relative_key: str, data: Dict[str, Any]) -> tuple[str, str, int]:
        full_key = self._full_key(relative_key)
        expected_bytes = self.canonical_json_bytes(data)
        expected_len = len(expected_bytes)
        expected_sha = self.sha256_hex(expected_bytes)
        self.backend.put_bytes(full_key, expected_bytes)
        readback = self.backend.get_bytes(full_key)
        if readback is None or len(readback) != expected_len or self.sha256_hex(readback) != expected_sha:
            raise StorageIntegrityError(f"JSON 账本写入回读哈希不一致: {full_key}")
        return full_key, expected_sha, expected_len

    def get_event_ledger(self, event_id: str) -> Optional[Dict[str, Any]]:
        return self.read_json(f"ledger/events/{event_id}.json")

    def save_event_ledger(self, event_id: str, record: Dict[str, Any]) -> None:
        self.write_json_verified(f"ledger/events/{event_id}.json", record)

    def get_daily_budget_used(self, date_yyyy_mm_dd: str) -> int:
        doc = self.read_json(f"ledger/budget/{date_yyyy_mm_dd}.json")
        if not doc:
            return 0
        return int(doc.get("usedRequests", 0))

    def increment_daily_budget(self, date_yyyy_mm_dd: str, delta: int = 1, reason: str = "api_call") -> int:
        current = self.get_daily_budget_used(date_yyyy_mm_dd)
        updated = current + delta
        self.write_json_verified(
            f"ledger/budget/{date_yyyy_mm_dd}.json",
            {"date": date_yyyy_mm_dd, "usedRequests": updated, "lastReason": reason},
        )
        return updated

    def get_request_state(self, cache_fingerprint: str) -> Optional[Dict[str, Any]]:
        return self.read_json(f"ledger/requests/{cache_fingerprint}.json")

    def save_request_state(self, cache_fingerprint: str, state: Dict[str, Any]) -> None:
        self.write_json_verified(f"ledger/requests/{cache_fingerprint}.json", state)

    def promote_latest_valid_manifest(
        self,
        iso_week: str,
        report_key: str,
        report_sha256: str,
        report_byte_len: int,
        source_as_of_max: Optional[str],
        updated_at: str,
    ) -> str:
        manifest = {
            "isoWeek": iso_week,
            "latestValidReportKey": report_key,
            "reportSha256": report_sha256,
            "reportByteLength": report_byte_len,
            "globalSourceAsOfMax": source_as_of_max,
            "promotedAt": updated_at,
        }
        key, _, _ = self.write_json_verified(f"reports/v1/{iso_week}/manifest_latest_valid.json", manifest)
        self.write_json_verified("reports/v1/manifest_latest_global.json", manifest)
        return key


    def record_latest_attempt_manifest(
        self,
        report_key: str,
        report_sha256: str,
        report_byte_len: int,
        overall_status: str,
        source_as_of_max: Optional[str],
        updated_at: str,
    ) -> str:
        manifest = {
            "latestReportKey": report_key,
            "reportSha256": report_sha256,
            "reportByteLength": report_byte_len,
            "overallStatus": overall_status,
            "globalSourceAsOfMax": source_as_of_max,
            "attemptedAt": updated_at,
        }
        key, _, _ = self.write_json_verified("reports/v1/manifest_latest_attempt.json", manifest)
        return key
