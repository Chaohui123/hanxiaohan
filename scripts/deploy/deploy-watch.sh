#!/bin/bash
# ============================================================
# ONZO Deploy Watch — pull-and-deploy when origin/main moves.
# Poor man's CI: used while GitHub Actions is unavailable
# (billing-locked). Runs from cron every 5 minutes on the server.
# Same actions as the CI deploy job: fetch + hard reset + compose up.
#
# 2026-10-22 修复（cron 环境 git fetch 静默失败实证）：
#   - 显式 PATH/HOME，exec 全量进日志，ERR trap 记录失败行+飞书告警
#   - GIT_SSH_COMMAND 显式 deploy key（cron 无 SSH agent 时也可靠 fetch）
#   - cron 行须改为 /bin/bash 且去掉 >/dev/null 2>&1（别再吞错）
# ============================================================
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
HOME=/home/ubuntu
export PATH HOME

REPO_DIR="${ONZO_REPO_DIR:-/home/ubuntu/onzo}"
LOG_FILE="${DEPLOY_WATCH_LOG:-/home/ubuntu/deploy-watch.log}"
COMPOSE_PROFILE="${COMPOSE_PROFILE:-production}"
read_env_value() {
  local key="$1"
  [[ -f .env.production ]] || return 0
  sed -n "s/^${key}=//p" .env.production | tail -1 | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}
FEISHU_WEBHOOK="${FEISHU_WEBHOOK:-${NOTIFY_FEISHU_WEBHOOK:-$(read_env_value NOTIFY_FEISHU_WEBHOOK)}}"
FEISHU_SECRET="${FEISHU_SECRET:-${NOTIFY_FEISHU_SECRET:-$(read_env_value NOTIFY_FEISHU_SECRET)}}"

set -euo pipefail
cd "$REPO_DIR"

# 全量输出进日志（别再靠 cron 重定向）
exec >>"$LOG_FILE" 2>&1

feishu_alert() {
  # $1=级别 $2=内容（纯文本）；失败不阻塞主流程
  # 飞书签名算法实证：sign = Base64(HMAC-SHA256(key="${timestamp}\n${secret}", data=""))
  # ——key 是「时间戳+换行+secret」，data 为空串（不是 key=secret/data=时间戳+secret，别搞反）
  local level="$1" msg="$2" ts key sign
  if [[ -z "$FEISHU_WEBHOOK" || -z "$FEISHU_SECRET" ]]; then
    echo "[$(date -Is)] WARN: feishu credentials unavailable; alert suppressed" >>"$LOG_FILE"
    return 0
  fi
  ts=$(date +%s)
  key="${ts}"$'\n'"${FEISHU_SECRET}"
  sign=$(printf '' | openssl dgst -sha256 -hmac "$key" -binary 2>/dev/null | openssl base64 2>/dev/null || echo "")
  curl -sf -m 8 -X POST "$FEISHU_WEBHOOK" -H 'Content-Type: application/json' \
    -d "{\"timestamp\":\"$ts\",\"sign\":\"$sign\",\"msg_type\":\"text\",\"content\":{\"text\":\"[deploy-watch][$level] $msg (host $(hostname))\"}}" \
    >>"$LOG_FILE" 2>&1 || echo "[$(date -Is)] WARN: feishu alert send failed" >>"$LOG_FILE"
}

trap 'rc=$?; echo "[$(date -Is)] ERROR line $LINENO: $BASH_COMMAND (exit $rc)"; feishu_alert "error" "deploy-watch 失败 line $LINENO: $BASH_COMMAND (exit $rc)"; exit "$rc"' ERR

echo "[$(date -Is)] deploy-watch start uid=$(id -u) host=$(hostname)"

# 显式 deploy key + BatchMode：cron 无 SSH agent 也能 fetch；无交互卡死
export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/onzo_deploy_key -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new"

git fetch origin -q
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

echo "[$(date -Is)] new commits ${LOCAL:0:7} -> ${REMOTE:0:7} — deploying"
feishu_alert "info" "检测到新 commit ${LOCAL:0:7}→${REMOTE:0:7}，开始部署" || true

# History was rewritten once — always hard reset, never pull/merge.
git reset --hard origin/main

docker compose --profile "$COMPOSE_PROFILE" --env-file .env.production up -d --build

# Caddy must be restarted on every deploy: single-file bind mounts pin the
# OLD inode — git reset replaces the file (new inode), so without a restart
# Caddy keeps serving the deleted file's config forever.
docker restart onzo-caddy || true

# Agents hold keep-alive connections to api-services; after an api rebuild the
# pooled connections point at the dead instance and every call ECONNREFUSEDs
# until the agent restarts. Bounce them so they re-resolve and reconnect.
docker restart onzo-promo-agent onzo-ops-agent || true

# Keep build cache bounded: -f alone only drops dangling layers and let the
# cache grow to 45GB (filled /var/lib/docker once). Cap at 10G instead.
docker builder prune -af --keep-storage 10g || true

# Health gate — log but don't fail hard (containers may still be starting).
sleep 15
if curl -sf -m 10 http://localhost:3000/health > /dev/null 2>&1; then
  echo "[$(date -Is)] deploy OK — /health green"
  feishu_alert "info" "部署完成 ${REMOTE:0:7}，/health green" || true
else
  echo "[$(date -Is)] WARN: /health not green yet after deploy — check docker compose logs"
  feishu_alert "warn" "部署后 /health 未转绿（${REMOTE:0:7}），请检查 docker compose logs" || true
fi
