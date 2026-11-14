from __future__ import annotations

import os
import re
from typing import Any, Dict

from src.iam_metadata import MetadataIamTokenProvider, assert_no_forbidden_static_credentials
from src.storage_ledger import VerifiedWordstatStore, YandexIamObjectStorageBackend


def handler(event: Dict[str, Any], _context: Any) -> Dict[str, Any]:
    assert_no_forbidden_static_credentials()
    if not event or event.get("operation") != "verify_storage_readback":
        raise ValueError("存储探针需要显式 operation=verify_storage_readback，不处理Timer或其他事件")
    probe_id = str(event.get("probeId") or "")
    if not re.fullmatch(r"[a-z0-9-]{8,80}", probe_id):
        raise ValueError("probeId必须为8-80位小写字母、数字或连字符")
    iam = MetadataIamTokenProvider()
    backend = YandexIamObjectStorageBackend(
        bucket_name=os.environ["WORDSTAT_BUCKET_NAME"],
        token_getter=iam.get_token,
    )
    store = VerifiedWordstatStore(backend, prefix="wordstat-weekly-probe")
    key, sha256, byte_length = store.write_json_verified(
        f"readback/{probe_id}.json",
        {"probeId": probe_id, "purpose": "metadata_iam_storage_only", "wordstatRequestsSent": False},
    )
    return {
        "status": "STORAGE_READBACK_VERIFIED",
        "storageKey": key,
        "reportSha256": sha256,
        "reportByteLength": byte_length,
        "wordstatRequestsSent": False,
        "feishuSent": False,
        "sellerCredentialsUsed": False,
    }
