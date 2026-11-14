#!/usr/bin/env bash
set -euo pipefail

: "${YANDEX_CLOUD_FOLDER_ID:?设置目标文件夹}"
: "${WORDSTAT_BUCKET_NAME:?设置对象存储桶}"
: "${FN_RUNNER_SA_ID:?仅含Search API与目标存储上传权限的运行账号}"
: "${TIMER_INVOKER_SA_ID:?仅含functions.functionInvoker的Timer账号}"
: "${RELEASE_TAG:?设置经过验收的固定版本标签}"

FUNCTION_NAME="${FUNCTION_NAME:-onzo-wordstat-weekly}"
TIMER_NAME="${TIMER_NAME:-onzo-wordstat-weekly-0900}"
CRON_EXPRESSION="0 1 ? * MON *"
if [[ "${RELEASE_TAG}" == "\$latest" || "${RELEASE_TAG}" == "latest" ]]; then
  echo "严禁将生产 Timer 直接绑定到未经验证的 \$latest 标签" >&2
  exit 1
fi
if ! yc serverless function get --name "${FUNCTION_NAME}" --folder-id "${YANDEX_CLOUD_FOLDER_ID}" >/dev/null 2>&1; then
  if [[ "${BIND_EXISTING_VERSION_ONLY:-false}" == "true" ]]; then
    echo "只绑定现有版本时目标函数必须已存在" >&2
    exit 1
  fi
  yc serverless function create --name "${FUNCTION_NAME}" --folder-id "${YANDEX_CLOUD_FOLDER_ID}" --description "ONZO Wordstat只读观察周报"
fi
FUNCTION_ID="$(yc serverless function get --name "${FUNCTION_NAME}" --folder-id "${YANDEX_CLOUD_FOLDER_ID}" --format=json | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
if [[ "${BIND_EXISTING_VERSION_ONLY:-false}" == "true" ]]; then
  VERSION_ID="$(yc serverless function version list --function-id "${FUNCTION_ID}" --format=json | python3 -c '
import json
import os
import sys
rows = json.load(sys.stdin)
tag = os.environ["RELEASE_TAG"]
matched = [row for row in rows if tag in row.get("tags", [])]
if len(matched) != 1:
    raise SystemExit("固定标签必须唯一对应现有版本")
version = matched[0]
if version.get("status") != "ACTIVE" or version.get("entrypoint") != os.environ.get("FUNCTION_ENTRYPOINT", "main.handler") or version.get("service_account_id") != os.environ["FN_RUNNER_SA_ID"]:
    raise SystemExit("现有版本状态、入口或运行账号与验收目标不一致")
print(version["id"])
')"
  echo "使用已验收的现有版本 ${VERSION_ID}，不重新创建版本"
else
  PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  BUILD_DIR="$(mktemp -d /tmp/onzo-wordstat-build.XXXXXX)"
  trap 'rm -rf "${BUILD_DIR}"' EXIT
  PACKAGE_DIR="${BUILD_DIR}/package"
  ZIP_FILE="${BUILD_DIR}/wordstat-${RELEASE_TAG}.zip"

  mkdir -p "${PACKAGE_DIR}"
  cp "${PROJECT_ROOT}/main.py" "${PROJECT_ROOT}/config.yaml" "${PROJECT_ROOT}/requirements.txt" "${PACKAGE_DIR}/"
  cp -r "${PROJECT_ROOT}/src" "${PACKAGE_DIR}/src"
  python3 - "${PACKAGE_DIR}" "${ZIP_FILE}" <<'PY'
from pathlib import Path
import sys
import zipfile
root = Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], "w", zipfile.ZIP_DEFLATED) as archive:
    for file in root.rglob("*"):
        if not file.is_file():
            continue
        relative = file.relative_to(root)
        if any(part in {"__pycache__", ".git", ".local_wordstat_store"} for part in relative.parts):
            continue
        if file.suffix == ".pyc" or file.name.startswith(".env"):
            continue
        archive.write(file, str(relative))
PY

  if ! yc serverless function get --name "${FUNCTION_NAME}" --folder-id "${YANDEX_CLOUD_FOLDER_ID}" >/dev/null 2>&1; then
    yc serverless function create --name "${FUNCTION_NAME}" --folder-id "${YANDEX_CLOUD_FOLDER_ID}" --description "ONZO Wordstat只读观察周报"
    FUNCTION_ID="$(yc serverless function get --name "${FUNCTION_NAME}" --folder-id "${YANDEX_CLOUD_FOLDER_ID}" --format=json | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
  fi
  VERSION_JSON="$(yc serverless function version create \
    --function-name "${FUNCTION_NAME}" \
    --folder-id "${YANDEX_CLOUD_FOLDER_ID}" \
    --runtime=python311 \
    --entrypoint="${FUNCTION_ENTRYPOINT:-main.handler}" \
    --memory=256m \
    --execution-timeout=300s \
    --service-account-id="${FN_RUNNER_SA_ID}" \
    --source-path="${ZIP_FILE}" \
    --environment="YANDEX_CLOUD_FOLDER_ID=${YANDEX_CLOUD_FOLDER_ID},WORDSTAT_STORAGE_BACKEND=s3_iam,WORDSTAT_BUCKET_NAME=${WORDSTAT_BUCKET_NAME},WORDSTAT_STORAGE_PREFIX=wordstat-weekly,WORDSTAT_DRY_RUN=false" \
    --format=json)"
  VERSION_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"${VERSION_JSON}")"
  echo "已创建待验版本 ${VERSION_ID}"
  yc serverless function version set-tag --id "${VERSION_ID}" --tag "${RELEASE_TAG}"
fi

if [[ "${CONFIRM_WORDSTAT_PROBE:-false}" == "true" ]]; then
  if [[ "${FUNCTION_ENTRYPOINT:-main.handler}" != "src.storage_probe.handler" ]]; then
    echo "存储探针必须显式使用 src.storage_probe.handler，禁止借此运行完整采集" >&2
    exit 1
  fi
  yc serverless function invoke --id "${FUNCTION_ID}" --tag "${RELEASE_TAG}" --data "{\"operation\":\"verify_storage_readback\",\"probeId\":\"deploy-${RELEASE_TAG}\"}" --format=json
fi
if [[ "${CONFIRM_WORDSTAT_LIVE_RUN:-false}" == "true" ]]; then
  if [[ "${FUNCTION_ENTRYPOINT:-main.handler}" != "main.handler" ]]; then
    echo "完整周报只能由 main.handler 显式执行" >&2
    exit 1
  fi
  yc serverless function invoke --id "${FUNCTION_ID}" --tag "${RELEASE_TAG}" --data "{\"event_metadata\":{\"event_id\":\"deploy-${RELEASE_TAG}\"}}" --format=json
fi

if [[ "${CONFIRM_WORDSTAT_TIMER:-false}" != "true" ]]; then
  echo "函数版本已保留；CONFIRM_WORDSTAT_TIMER未开启，不创建Timer"
  exit 0
fi
if yc serverless trigger v2 get --name "${TIMER_NAME}" --folder-id "${YANDEX_CLOUD_FOLDER_ID}" >/dev/null 2>&1; then
  echo "Timer已存在，不删除、不覆盖；请回读现有版本标签后再决定是否需要迁移"
  yc serverless trigger v2 get --name "${TIMER_NAME}" --folder-id "${YANDEX_CLOUD_FOLDER_ID}" --format=yaml
  exit 0
fi
TIMER_ACTION="$(python3 - "${FUNCTION_ID}" "${RELEASE_TAG}" "${TIMER_INVOKER_SA_ID}" "${DLQ_QUEUE_ID:-}" "${DLQ_SERVICE_ACCOUNT_ID:-}" <<'PY'
import json
import sys
function_id, tag, invoker_id, dlq_queue, dlq_account = sys.argv[1:]
if bool(dlq_queue) != bool(dlq_account):
    raise SystemExit("DLQ队列与写入账号必须同时提供")
action = {
    "invokeFunction": {"functionId": function_id, "functionTag": tag, "serviceAccountId": invoker_id},
    "retryPolicy": {"retryAttempts": 1, "interval": "60s"},
}
if dlq_queue:
    action["deadLetter"] = {"deadLetterQueue": {"queueArn": dlq_queue, "serviceAccountId": dlq_account, "messageAttributes": {}}}
print(json.dumps(action, separators=(",", ":")))
PY
)"
yc serverless trigger v2 create timer \
  --name "${TIMER_NAME}" \
  --folder-id "${YANDEX_CLOUD_FOLDER_ID}" \
  --cron-expression "${CRON_EXPRESSION}" \
  --payload "wordstat-weekly" \
  --action "${TIMER_ACTION}" \
  --format=yaml
yc serverless trigger v2 get --name "${TIMER_NAME}" --folder-id "${YANDEX_CLOUD_FOLDER_ID}" --format=yaml
