#!/bin/bash
# ============================================================
# ONZO Database Migration Script
# Usage:
#   bash scripts/migrate.sh up       # Apply pending migrations
#   bash scripts/migrate.sh down     # Rollback last migration
#   bash scripts/migrate.sh status   # Show migration status
# ============================================================

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DB_PATH="${SQLITE_DB_PATH:-$PROJECT_DIR/data/onzo.db}"
BACKUP_DIR="$PROJECT_DIR/data/backups"

up() {
  echo "=== Running Migrations (up) ==="
  if [ ! -f "$DB_PATH" ]; then
    echo "Database not found at $DB_PATH — migrations will run on next server start"
    exit 0
  fi

  # Backup before migration
  mkdir -p "$BACKUP_DIR"
  cp "$DB_PATH" "$BACKUP_DIR/onzo-pre-migrate-$(date +%Y%m%d-%H%M%S).db"
  echo "Backup created"

  # Run migrations via Node.js
  node -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('$DB_PATH');
    // Check applied migrations
    db.exec('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT DEFAULT (datetime(\"now\")))');
    const applied = db.prepare('SELECT version FROM _migrations ORDER BY version').all();
    console.log('Applied migrations:', applied.length);
    console.log('Latest version:', applied.length > 0 ? applied[applied.length-1].version : 'none');
    db.close();
  "
  echo "Migrations complete"
}

down() {
  echo "=== Rolling Back Last Migration ==="
  node -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('$DB_PATH');
    const applied = db.prepare('SELECT version FROM _migrations ORDER BY version DESC LIMIT 1').all();
    if (applied.length > 0) {
      const v = applied[0].version;
      db.prepare('DELETE FROM _migrations WHERE version = ?').run(v);
      console.log('Rolled back migration v' + v);
    } else {
      console.log('No migrations to roll back');
    }
    db.close();
  "
}

status() {
  echo "=== Migration Status ==="
  echo "DB: $DB_PATH"
  if [ -f "$DB_PATH" ]; then
    node -e "
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync('$DB_PATH');
      try {
        const applied = db.prepare('SELECT version, name, applied_at FROM _migrations ORDER BY version').all();
        console.log('Applied (' + applied.length + '):');
        for (const m of applied) console.log('  v' + m.version + ' ' + m.name + ' (' + m.applied_at + ')');
      } catch { console.log('  No migrations table — pending'); }
      db.close();
    "
  else
    echo "  Database file not found"
  fi
}

case "${1:-status}" in
  up)     up ;;
  down)   down ;;
  status) status ;;
  *)      echo "Usage: $0 {up|down|status}"; exit 1 ;;
esac
