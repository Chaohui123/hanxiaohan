#!/bin/bash
# ============================================================
# ONZO Database Migration Script (PostgreSQL)
# Usage:
#   bash scripts/migrate.sh up       # Apply pending migrations
#   bash scripts/migrate.sh down     # Rollback last migration
#   bash scripts/migrate.sh status   # Show migration status
# ============================================================

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="$PROJECT_DIR/data/backups"

# Docker-only servers have no node runtime on the host — the api-services
# container manages its own schema at startup, so migrations are a no-op there.
if ! command -v npx &>/dev/null; then
  echo "SKIP: npx not available on host — schema is managed by the api-services container at startup"
  exit 0
fi

up() {
  echo "=== Running Migrations (up) ==="
  cd "$PROJECT_DIR/apps/api-services"

  npx tsx -e "
    import { getDb } from './src/db/connection.js';
    import { MIGRATIONS } from './src/db/migrations.js';
    import { runMigrations } from './src/db/migrate.js';
    const db = await getDb();
    if (!db) { console.error('DB unavailable — check DATABASE_URL'); process.exit(1); }
    const count = await runMigrations(db, MIGRATIONS);
    console.log('Applied ' + count + ' migration(s)');
  "

  echo "Migrations complete"
}

down() {
  echo "=== Rolling Back Last Migration ==="
  cd "$PROJECT_DIR/apps/api-services"

  npx tsx -e "
    import { getDb } from './src/db/connection.js';
    const db = await getDb();
    if (!db) { console.error('DB unavailable — check DATABASE_URL'); process.exit(1); }
    const rows = await db.all('SELECT version FROM _migrations ORDER BY version DESC LIMIT 1');
    if (rows.length > 0) {
      await db.run('DELETE FROM _migrations WHERE version = \$1', [rows[0].version]);
      console.log('Rolled back migration v' + rows[0].version);
    } else {
      console.log('No migrations to roll back');
    }
  "
}

status() {
  echo "=== Migration Status ==="
  echo "DB: ${DATABASE_URL:-postgresql://onzo:onzo@localhost:5432/onzo_prod}"
  cd "$PROJECT_DIR/apps/api-services"

  npx tsx -e "
    import { getDb } from './src/db/connection.js';
    const db = await getDb();
    if (!db) { console.error('DB unavailable — check DATABASE_URL'); process.exit(1); }
    try {
      const rows = await db.all('SELECT version, name, applied_at FROM _migrations ORDER BY version');
      console.log('Applied (' + rows.length + '):');
      for (const m of rows) console.log('  v' + m.version + ' ' + m.name + ' (' + m.applied_at + ')');
    } catch { console.log('  No migrations table — pending'); }
  "
}

case "${1:-status}" in
  up)     up ;;
  down)   down ;;
  status) status ;;
  *)      echo "Usage: $0 {up|down|status}"; exit 1 ;;
esac
