#!/bin/bash
# ============================================================
# ONZO Deploy Watch — pull-and-deploy when origin/main moves.
# Poor man's CI: used while GitHub Actions is unavailable
# (billing-locked). Runs from cron every 5 minutes on the server.
# Same actions as the CI deploy job: fetch + hard reset + compose up.
# ============================================================
set -euo pipefail

REPO_DIR="${ONZO_REPO_DIR:-/home/ubuntu/onzo}"
LOG_FILE="${DEPLOY_WATCH_LOG:-/home/ubuntu/deploy-watch.log}"
COMPOSE_PROFILE="${COMPOSE_PROFILE:-production}"

cd "$REPO_DIR"

git fetch origin -q
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

echo "[$(date -Iseconds)] new commits ${LOCAL:0:7} -> ${REMOTE:0:7} — deploying" >> "$LOG_FILE"

# History was rewritten once — always hard reset, never pull/merge.
git reset --hard origin/main >> "$LOG_FILE" 2>&1

docker compose --profile "$COMPOSE_PROFILE" --env-file .env.production up -d --build >> "$LOG_FILE" 2>&1

# Caddy must be restarted on every deploy: single-file bind mounts pin the
# OLD inode — git reset replaces the file (new inode), so without a restart
# Caddy keeps serving the deleted file's config forever.
docker restart onzo-caddy >> "$LOG_FILE" 2>&1 || true

# Keep build cache bounded (buildkitd GC also applies).
docker builder prune -f >> "$LOG_FILE" 2>&1 || true

# Health gate — log but don't fail hard (containers may still be starting).
sleep 15
if curl -sf -m 10 http://localhost:3000/health > /dev/null 2>&1; then
  echo "[$(date -Iseconds)] deploy OK — /health green" >> "$LOG_FILE"
else
  echo "[$(date -Iseconds)] WARN: /health not green yet after deploy — check docker compose logs" >> "$LOG_FILE"
fi
