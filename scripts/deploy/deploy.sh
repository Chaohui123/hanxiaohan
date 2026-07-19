#!/bin/bash
# ============================================================
# ONZO Deploy Script — deploy / rollback / status
# Uses Docker Compose + PostgreSQL pg_dump backups
# Usage:
#   bash scripts/deploy.sh deploy    # Full deploy with health check
#   bash scripts/deploy.sh rollback  # Rollback to previous version
#   bash scripts/deploy.sh status    # Show current deployment status
# ============================================================

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="$PROJECT_DIR/data/backups"
LOG_FILE="/tmp/onzo.log"
HEALTH_URL="${HEALTH_URL:-http://localhost:3000/health}"
ENV_FILE="${ENV_FILE:-.env.production}"

cd "$PROJECT_DIR"

deploy() {
  echo "=== ONZO Deploy ==="
  echo "Time: $(date -Iseconds)"

  # 1. Backup PG
  echo "[1/5] Backing up PostgreSQL..."
  mkdir -p "$BACKUP_DIR"
  BACKUP_FILE="$BACKUP_DIR/onzo-pre-deploy-$(date +%Y%m%d-%H%M%S).sql.gz"
  if command -v docker &>/dev/null && docker ps 2>/dev/null | grep -q onzo-postgres; then
    docker exec onzo-postgres pg_dump -U onzo onzo_prod | gzip > "$BACKUP_FILE"
    echo "  Backup saved: $BACKUP_FILE"
  elif command -v pg_dump &>/dev/null; then
    pg_dump --no-owner --no-privileges "${DATABASE_URL:-postgresql://onzo:onzo@localhost:5432/onzo_prod}" | gzip > "$BACKUP_FILE"
    echo "  Backup saved (local pg_dump): $BACKUP_FILE"
  else
    echo "  PostgreSQL not available — skipping backup"
  fi

  # 2. Git pull
  echo "[2/5] Pulling latest code..."
  git pull origin main 2>/dev/null || echo "  Not a git repo — skipping pull"

  # 3. Migrate
  echo "[3/5] Running migrations..."
  bash "$SCRIPT_DIR/migrate.sh" up || echo "  Migration skipped or failed"

  # 4. Restart via Docker Compose
  echo "[4/5] Rebuilding and restarting..."
  if command -v docker &>/dev/null && docker compose version &>/dev/null; then
    docker compose --profile production --env-file "$ENV_FILE" up -d --build
    echo "  Docker Compose deploy complete"
  else
    echo "  Docker not available — cannot restart"
    return 1
  fi

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
  local latest_backup=$(ls -t "$BACKUP_DIR"/onzo-pre-deploy-*.sql.gz 2>/dev/null | head -1)
  if [ -z "$latest_backup" ]; then
    echo "No backup found — cannot rollback"
    exit 1
  fi

  echo "Restoring: $latest_backup"
  if command -v docker &>/dev/null && docker ps 2>/dev/null | grep -q onzo-postgres; then
    gunzip -c "$latest_backup" | docker exec -i onzo-postgres psql -U onzo onzo_prod
    echo "  DB restored via Docker"
  elif command -v psql &>/dev/null; then
    gunzip -c "$latest_backup" | psql "${DATABASE_URL:-postgresql://onzo:onzo@localhost:5432/onzo_prod}"
    echo "  DB restored via local psql"
  else
    echo "  No PostgreSQL client available — cannot restore"
    exit 1
  fi

  if command -v docker &>/dev/null; then
    docker compose --env-file "$ENV_FILE" restart api-services
    echo "Rollback complete. Service restarted."
  else
    echo "Rollback complete. Restart service manually."
  fi
}

status() {
  echo "=== ONZO Status ==="
  echo "Time: $(date -Iseconds)"

  # Docker status
  if command -v docker &>/dev/null; then
    echo ""
    echo "Docker containers:"
    docker compose ps 2>/dev/null || echo "  docker compose not available"
  fi

  # Service health
  if curl -s --connect-timeout 3 "$HEALTH_URL" 2>/dev/null | grep -q '"status":"ok"'; then
    echo "Service: ✅ Running"
    uptime=$(curl -s "$HEALTH_URL" | grep -o '"uptime":[0-9.]*' | cut -d: -f2 2>/dev/null)
    echo "Uptime: ${uptime:-unknown}s"
  else
    echo "Service: ❌ Not responding"
  fi

  # Backups
  echo ""
  echo "Backups:"
  ls -lh "$BACKUP_DIR"/onzo-*.sql.gz 2>/dev/null | tail -5 || echo "  No backups"
}

# Main
case "${1:-status}" in
  deploy)   deploy ;;
  rollback) rollback ;;
  status)   status ;;
  *)        echo "Usage: $0 {deploy|rollback|status}"; exit 1 ;;
esac
