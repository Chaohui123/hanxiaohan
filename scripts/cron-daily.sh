#!/bin/bash
# ============================================================
# ONZO Daily Cron — backup + cleanup + LLM stats
# Run: 0 3 * * * bash /root/onzo/scripts/cron-daily.sh >> /var/log/onzo-cron.log 2>&1
# ============================================================
set -e
if [ -z "${API_KEY:-}" ]; then
  echo "ERROR: API_KEY environment variable is required (no default; set it in crontab or /etc/environment)" >&2
  exit 1
fi
BASE="${API_BASE:-http://localhost:3000}"
HDR="X-API-Key: $API_KEY"

echo "[$(date)] ONZO Daily Cron Start"

# 1. Backup
echo "  Running backup..."
curl -sf -X POST "$BASE/api/db/backup" -H "$HDR" && echo "  Backup OK" || echo "  Backup FAILED"

# 2. Cleanup
echo "  Running cleanup..."
curl -sf -X POST "$BASE/api/ops/cleanup" -H "$HDR" && echo "  Cleanup OK" || echo "  Cleanup FAILED"

# 3. LLM Stats
echo "  LLM Stats:"
curl -sf "$BASE/api/stats/llm" -H "$HDR" | head -c 500

echo "[$(date)] ONZO Daily Cron Done"
