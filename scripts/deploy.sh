#!/bin/bash
# ============================================================
# ONZO Deploy Script — deploy / rollback / status
# Usage:
#   bash scripts/deploy.sh deploy    # Full deploy with health check
#   bash scripts/deploy.sh rollback  # Rollback to previous version
#   bash scripts/deploy.sh status    # Show current deployment status
# ============================================================

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
APP_DIR="$PROJECT_DIR/apps/api-services"
BACKUP_DIR="$PROJECT_DIR/data/backups"
LOG_FILE="/tmp/onzo.log"
HEALTH_URL="${HEALTH_URL:-http://localhost:3000/health}"

cd "$PROJECT_DIR"

deploy() {
  echo "=== ONZO Deploy ==="
  echo "Time: $(date -Iseconds)"

  # 1. Backup DB
  echo "[1/5] Backing up database..."
  mkdir -p "$BACKUP_DIR"
  if [ -f "$PROJECT_DIR/data/onzo.db" ]; then
    cp "$PROJECT_DIR/data/onzo.db" "$BACKUP_DIR/onzo-pre-deploy-$(date +%Y%m%d-%H%M%S).db"
    echo "  Backup saved"
  fi

  # 2. Git pull
  echo "[2/5] Pulling latest code..."
  git pull origin main 2>/dev/null || echo "  Not a git repo — skipping pull"

  # 3. Migrate
  echo "[3/5] Running migrations..."
  bash "$SCRIPT_DIR/migrate.sh" up || echo "  Migration skipped or failed"

  # 4. Restart
  echo "[4/5] Restarting service..."
  pkill -f "tsx.*index.ts" 2>/dev/null || true
  sleep 2
  cd "$APP_DIR"
  nohup npx tsx src/index.ts > "$LOG_FILE" 2>&1 &
  echo "  Service started (PID: $!)"

  # 5. Health check
  echo "[5/5] Health check..."
  for i in $(seq 1 12); do
    if curl -s --connect-timeout 3 "$HEALTH_URL" 2>/dev/null | grep -q '"status":"ok"'; then
      echo "  ✅ Health OK after ${i}0s"
      return 0
    fi
    sleep 10
  done
  echo "  ❌ Health check FAILED"
  return 1
}

rollback() {
  echo "=== Rollback ==="
  local latest_backup=$(ls -t "$BACKUP_DIR"/onzo-pre-deploy-*.db 2>/dev/null | head -1)
  if [ -z "$latest_backup" ]; then
    echo "No backup found — cannot rollback"
    exit 1
  fi

  echo "Restoring: $latest_backup"
  pkill -f "tsx.*index.ts" 2>/dev/null || true
  sleep 2
  cp "$latest_backup" "$PROJECT_DIR/data/onzo.db"
  cd "$APP_DIR"
  nohup npx tsx src/index.ts > "$LOG_FILE" 2>&1 &
  echo "Rollback complete. Service restarted."
}

status() {
  echo "=== ONZO Status ==="
  echo "Time: $(date -Iseconds)"

  # Service health
  if curl -s --connect-timeout 3 "$HEALTH_URL" 2>/dev/null | grep -q '"status":"ok"'; then
    echo "Service: ✅ Running"
    uptime=$(curl -s "$HEALTH_URL" | grep -o '"uptime":[0-9.]*' | cut -d: -f2 2>/dev/null)
    echo "Uptime: ${uptime:-unknown}s"
  else
    echo "Service: ❌ Not responding"
  fi

  # Recent logs
  echo ""
  echo "Recent logs:"
  tail -5 "$LOG_FILE" 2>/dev/null || echo "  No logs found"

  # Backups
  echo ""
  echo "Backups:"
  ls -lh "$BACKUP_DIR"/onzo-*.db 2>/dev/null | tail -5 || echo "  No backups"
}

# Main
case "${1:-status}" in
  deploy)   deploy ;;
  rollback) rollback ;;
  status)   status ;;
  *)        echo "Usage: $0 {deploy|rollback|status}"; exit 1 ;;
esac
