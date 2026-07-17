#!/bin/bash
# ============================================================
# ONZO Database Backup — standalone script
# Creates a compressed SQL dump before deploy or on schedule.
# Usage:
#   bash scripts/backup-db.sh
# ============================================================

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/data/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"

mkdir -p "$BACKUP_DIR"

BACKUP_FILE="$BACKUP_DIR/onzo-pre-deploy-$(date +%Y%m%d-%H%M%S).sql.gz"

echo "=== ONZO Database Backup ==="
echo "Time: $(date -Iseconds)"

# Try Docker pg_dump first
if command -v docker &>/dev/null && docker ps 2>/dev/null | grep -q onzo-postgres; then
  echo "Backing up via Docker..."
  docker exec onzo-postgres pg_dump -U onzo onzo_prod | gzip > "$BACKUP_FILE"
  echo "Backup saved: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"

# Fallback: local pg_dump
elif command -v pg_dump &>/dev/null; then
  echo "Backing up via local pg_dump..."
  pg_dump --no-owner --no-privileges \
    "${DATABASE_URL:-postgresql://onzo:onzo@localhost:5432/onzo_prod}" | gzip > "$BACKUP_FILE"
  echo "Backup saved: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"

else
  echo "ERROR: No PostgreSQL client available — cannot backup"
  exit 1
fi

# Cleanup old backups
echo "Cleaning backups older than $RETENTION_DAYS days..."
find "$BACKUP_DIR" -name "onzo-pre-deploy-*.sql.gz" -mtime "+$RETENTION_DAYS" -delete 2>/dev/null || true
find "$BACKUP_DIR" -name "onzo-daily-*.sql.gz" -mtime "+$RETENTION_DAYS" -delete 2>/dev/null || true

echo "Backup complete. $(ls "$BACKUP_DIR"/*.sql.gz 2>/dev/null | wc -l) backups retained."
