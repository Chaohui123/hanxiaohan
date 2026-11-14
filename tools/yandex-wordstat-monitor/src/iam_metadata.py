from __future__ import annotations

import os
import time
from typing import Callable, Optional
import httpx

METADATA_TOKEN_URL = "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token"
METADATA_HEADERS = {"Metadata-Flavor": "Google"}


class SecurityConfigurationError(RuntimeError):
    pass


class MetadataIamError(RuntimeError):
    pass


def assert_no_forbidden_static_credentials(env: Optional[dict] = None) -> None:
    target_env = env if env is not None else os.environ
    forbidden_keys = [
        "YANDEX_API_KEY",
        "YC_SERVICE_ACCOUNT_KEY_JSON",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "FEISHU_WEBHOOK_URL",
        "FEISHU_SECRET",
        "NOTIFY_FEISHU_WEBHOOK",
        "NOTIFY_FEISHU_SECRET",
    ]
    present = [k for k in forbidden_keys if target_env.get(k, "").strip()]
    if present:
        raise SecurityConfigurationError(
            f"检测到禁止注入云函数的静态凭据或飞书秘密环境变量: {', '.join(present)}。"
            "云函数必须仅通过运行服务账号 Metadata 获取 IAM Token，并由 ONZO 服务端持有飞书通知秘密。"
        )


class MetadataIamTokenProvider:
    def __init__(
        self,
        http_client: Optional[httpx.Client] = None,
        refresh_margin_seconds: int = 120,
        clock: Callable[[], float] = time.time,
    ) -> None:
        assert_no_forbidden_static_credentials()
        self._client = http_client or httpx.Client(timeout=5.0)
        self._refresh_margin_seconds = refresh_margin_seconds
        self._clock = clock
        self._cached_token: Optional[str] = None
        self._expires_at: float = 0.0

    def get_token(self) -> str:
        now = self._clock()
        if self._cached_token and now + self._refresh_margin_seconds < self._expires_at:
            return self._cached_token

        try:
            resp = self._client.get(METADATA_TOKEN_URL, headers=METADATA_HEADERS)
        except httpx.RequestError as exc:
            raise MetadataIamError(f"无法连接 Yandex Cloud Metadata 服务获取 IAM Token: {exc}") from exc

        if resp.status_code != 200:
            raise MetadataIamError(
                f"Metadata IAM Token 请求失败，HTTP {resp.status_code}（请确认云函数已绑定最小权限运行服务账号）"
            )

        payload = resp.json()
        access_token = payload.get("access_token")
        expires_in = int(payload.get("expires_in", 3600))
        if not access_token or not isinstance(access_token, str):
            raise MetadataIamError("Metadata 返回缺少有效的 access_token 字段")

        self._cached_token = access_token
        self._expires_at = now + expires_in
        return access_token
