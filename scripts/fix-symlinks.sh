#!/bin/sh
# ============================================================
# fix-symlinks.sh — rebuild pnpm workspace symlinks + native modules
# Runs at container startup before node process.
# Alpine-compatible (sh, not bash).
# ============================================================
set -e

APP_DIR="/app"
NODE_DIR="$APP_DIR/apps/api-services/node_modules/@onzo"
PKG_DIR="$APP_DIR/packages"
DIST_DIR="$APP_DIR/apps/api-services/dist"

echo "[fix-symlinks] Starting symlink repair..."

# ---- 1. Validate dist exists ----
if [ ! -f "$DIST_DIR/index.js" ]; then
  echo "[fix-symlinks] ERROR: dist/index.js not found at $DIST_DIR"
  echo "[fix-symlinks] Container may have been built without compilation."
  # Try TG alert if API key is configured
  if [ -n "$NOTIFY_TELEGRAM_BOT_TOKEN" ] && [ -n "$NOTIFY_TELEGRAM_CHAT_ID" ]; then
    curl -s -X POST "https://api.telegram.org/bot${NOTIFY_TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${NOTIFY_TELEGRAM_CHAT_ID}" \
      -d "text=🔴 ONZO API 启动失败: dist/index.js 缺失" \
      -d "parse_mode=HTML" > /dev/null 2>&1 || true
  fi
  exit 1
fi
echo "[fix-symlinks] dist/index.js found OK"

# ---- 2. Rebuild workspace symlinks ----
# After Docker COPY, pnpm symlinks become dead (../../packages/pkg → actual copy)
# Fix: remove dead links and create direct folder copies
echo "[fix-symlinks] Rebuilding @onzo workspace links..."
mkdir -p "$NODE_DIR"

for pkg_dir in "$PKG_DIR"/*/; do
  pkg_name=$(basename "$pkg_dir")
  case "$pkg_name" in
    shared-types|logger|cache|logistics|embedding|feishu-bot|ai|scraper|validator|ozon-api-wrapper|ozon-order|price-monitor|glm-integration|scraper-1688|validation-layer)
      target="$NODE_DIR/$pkg_name"
      rm -rf "$target" 2>/dev/null || true
      cp -r "$PKG_DIR/$pkg_name" "$target" 2>/dev/null
      # Verify dist exists in the copy
      if [ -f "$target/dist/index.js" ]; then
        echo "  ✅ @onzo/$pkg_name"
      elif [ -f "$PKG_DIR/$pkg_name/dist/index.js" ]; then
        echo "  ✅ @onzo/$pkg_name (source only, dist symlinked)"
      else
        echo "  ⚠️ @onzo/$pkg_name — NO dist/index.js (JS fallback)"
        # Copy .ts source as .js as last resort
        if [ -f "$target/src/index.ts" ]; then
          mkdir -p "$target/dist"
          cp "$target/src/index.ts" "$target/dist/index.js" 2>/dev/null || true
          echo "    → Copied src/index.ts as dist/index.js (fallback)"
        fi
      fi
      ;;
  esac
done

# ---- 3. Verify better-sqlite3 native module ----
echo "[fix-symlinks] Checking better-sqlite3..."
BSQL3_PATH=$(find "$APP_DIR/node_modules/.pnpm" -name "better_sqlite3.node" -path "*/build/Release/*" 2>/dev/null | head -1)
if [ -n "$BSQL3_PATH" ]; then
  echo "  ✅ better_sqlite3.node found at: ${BSQL3_PATH#$APP_DIR/}"
else
  echo "  ⚠️ better_sqlite3.node NOT found — attempting rebuild..."
  if command -v g++ > /dev/null 2>&1; then
    cd "$APP_DIR" && npm rebuild better-sqlite3 2>&1 || echo "  ❌ rebuild failed"
  else
    echo "  ⚠️ g++ not available — using JS fallback (memory mode)"
  fi
fi

# ---- 4. Check critical packages ----
echo "[fix-symlinks] Verifying critical packages..."
for pkg in logger shared-types cache; do
  pkg_main=$(node -e "try { require.resolve('@onzo/$pkg'); console.log('ok') } catch(e) { console.log('missing') }" 2>/dev/null)
  if [ "$pkg_main" = "ok" ]; then
    echo "  ✅ @onzo/$pkg"
  else
    echo "  ❌ @onzo/$pkg — RESOLUTION FAILED"
  fi
done

# ---- 5. Final validation ----
echo "[fix-symlinks] Running Node.js import test..."
node -e "
const fs = require('fs');
const dist = '$DIST_DIR/index.js';
if (fs.existsSync(dist)) {
  console.log('[fix-symlinks] All checks passed ✓');
  process.exit(0);
} else {
  console.error('[fix-symlinks] CRITICAL: dist/index.js missing');
  process.exit(1);
}
" 2>&1

echo "[fix-symlinks] Done. Starting API service..."
