#!/bin/sh
# ============================================================
# ONZO Remote Backup — sync PostgreSQL backups to S3/OSS via rclone
#
# Setup:
#   1. Install rclone: https://rclone.org/install/
#   2. Configure remote: rclone config
#   3. Set RCLONE_REMOTE in .env (e.g. "s3:onzo-backups")
#   4. Schedule via cron: 0 */6 * * * /app/scripts/backup-remote.sh
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/data/backups}"
RCLONE_REMOTE="${RCLONE_REMOTE:-}"

if [ -z "$RCLONE_REMOTE" ]; then
  echo "[Backup] RCLONE_REMOTE not configured — skipping remote sync"
  exit 0
fi

echo "[Backup] Starting remote backup to $RCLONE_REMOTE"

# 1. Trigger local backup via API (if server is running)
LOCAL_BACKUP=$(curl -s -X POST http://localhost:${API_SERVICE_PORT:-3000}/api/db/backup 2>/dev/null || echo '{"success":false}')
echo "[Backup] Local backup: $LOCAL_BACKUP"

# 2. Sync backup directory to remote
if command -v rclone >/dev/null 2>&1; then
  echo "[Backup] Syncing $BACKUP_DIR → $RCLONE_REMOTE"
  rclone sync "$BACKUP_DIR" "$RCLONE_REMOTE" \
    --include "onzo-*.sql.gz" \
    --max-age 7d \
    --verbose \
    --retries 3
  echo "[Backup] Remote sync complete"
else
  echo "[Backup] ERROR: rclone not installed. Install from https://rclone.org/install/"
  exit 1
fi

# 3. Keep only last 30 days of remote backups
echo "[Backup] Cleaning remote backups older than 30 days"
rclone delete "$RCLONE_REMOTE" --min-age 30d --include "onzo-*.sql.gz" --verbose 2>/dev/null || true

echo "[Backup] Done"
