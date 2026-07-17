#!/bin/bash
# ============================================================
# Docker Build Cache Cleaner
# Usage: bash scripts/docker-clean.sh [--full]
#   --full  Clear ALL Docker build cache (slower next build)
#   (none)  Clear only dangling/unused cache
# ============================================================
set -e

if [ "${1:-}" = "--full" ]; then
  echo "==> Clearing ALL Docker build cache..."
  docker builder prune -af
else
  echo "==> Clearing dangling Docker build cache..."
  docker builder prune -f
fi

echo "==> Removing dangling images..."
docker image prune -f

echo "==> Cache cleared. Rebuild with:"
echo "    docker compose build --no-cache api-services"
echo "    docker compose --env-file .env up -d --build api-services"
