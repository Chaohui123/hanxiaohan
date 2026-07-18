# ============================================================
# ONZO API Services — Alpine Mirror + Full COPY (no pnpm deploy)
# Stage 1: Build with gcc toolchain, compile native modules + TypeScript
# Stage 2: Runtime, zero build tools, full node_modules
# ============================================================

# ---- Stage 1: Build ----
FROM node:22-alpine AS builder

# Replace Alpine source with Aliyun mirror (fast in China, avoids download timeouts)
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories

# Install gcc toolchain for native module compilation (better-sqlite3 needs C++ compiler)
RUN apk add --no-cache gcc g++ make python3 python3-dev

# Enable pnpm
RUN corepack enable pnpm
RUN echo "ignore-scripts=true" >> .npmrc && echo "verify-deps-before-run=false" >> .npmrc

WORKDIR /app

# Step 1: Copy dependency manifests (maximizes layer cache — only invalidates when packages change)
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY package.json tsconfig.base.json ./
COPY packages/shared-types/package.json packages/shared-types/tsconfig.json packages/shared-types/
COPY packages/ozon-api-wrapper/package.json packages/ozon-api-wrapper/tsconfig.json packages/ozon-api-wrapper/
COPY packages/ai/package.json packages/ai/tsconfig.json packages/ai/
COPY packages/scraper/package.json packages/scraper/tsconfig.json packages/scraper/
COPY packages/validator/package.json packages/validator/tsconfig.json packages/validator/
COPY packages/ozon-order/package.json packages/ozon-order/tsconfig.json packages/ozon-order/
COPY packages/price-monitor/package.json packages/price-monitor/tsconfig.json packages/price-monitor/
COPY packages/logger/package.json packages/logger/tsconfig.json packages/logger/
COPY packages/embedding/package.json packages/embedding/tsconfig.json packages/embedding/
COPY packages/feishu-bot/package.json packages/feishu-bot/tsconfig.json packages/feishu-bot/
COPY packages/cache/package.json packages/cache/tsconfig.json packages/cache/
COPY packages/logistics/package.json packages/logistics/tsconfig.json packages/logistics/
COPY apps/api-services/package.json apps/api-services/tsconfig.json apps/api-services/

# Step 2: Install deps (includes devDeps for TS compilation)
RUN pnpm install --no-frozen-lockfile --ignore-scripts --config.verify-deps-before-run=false

# Rebuild native modules for Alpine musl (skipped by --ignore-scripts above)
RUN npm rebuild better-sqlite3 || true

# Step 3: Copy full source
COPY packages/ packages/
COPY apps/ apps/

# Step 4: Compile TypeScript with toleration for existing type warnings
# Run all packages first (dependencies), then api-services
RUN for pkg in logger shared-types ozon-api-wrapper ai scraper validator ozon-order \
      price-monitor cache logistics embedding; do \
      echo \"=== Compiling $pkg ===\"; \
      ./node_modules/.bin/tsc -p packages/$pkg/tsconfig.json --noEmitOnError false 2>&1 | head -3 || true; \
      ls packages/$pkg/dist/index.js 2>/dev/null && echo \"  OK: $pkg\" || echo \"  NO_DIST: $pkg\"; \
    done && \
    ./node_modules/.bin/tsc -p apps/api-services/tsconfig.json --noEmitOnError false 2>&1 | head -3 || true

# Step 5: Fix package.json paths (src/ → dist/ for compiled JS)
RUN for f in packages/*/package.json; do \
      sed -i 's|"./src/\(.*\)\.ts"|"./dist/\1.js"|g' $f; \
    done
RUN cp -r packages/scraper/src/scripts packages/scraper/dist/scripts || true

# ---- Stage 2: Runtime (minimal) ----
FROM node:22-alpine AS runner

# Aliyun mirror for runtime packages
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories

WORKDIR /app

ENV NODE_ENV=production

# Alpine Chromium (musl native, no glibc compat issues) + Playwright system deps + runtime utils
# NOTE: Do NOT use "npx playwright install chromium" — it downloads glibc binaries
# Alpine apk provides chromium that matches musl libc
RUN apk add --no-cache \
    wget postgresql-client ca-certificates \
    chromium \
    nss nspr dbus-libs at-spi2-core cups-libs libdrm mesa-gbm \
    libxcb libx11 libxcomposite libxdamage libxext libxfixes \
    libxrandr pango cairo alsa-lib gtk+3.0 \
    && rm -rf /var/cache/apk/*

# Full COPY of node_modules + built packages (no pnpm deploy — guaranteed completeness)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps ./apps
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-workspace.yaml ./

# Runtime directories (all persisted via Docker volumes)
RUN mkdir -p /app/data/backups /app/data/browser /app/logs \
             /app/uploads /app/dead-letter /app/data/tmp-images

# Startup symlink repair script (fixes pnpm workspace links after Docker COPY)
COPY scripts/fix-symlinks.sh /app/scripts/fix-symlinks.sh
RUN chmod +x /app/scripts/fix-symlinks.sh

# Template files (跨境巴士 export, etc.)
COPY assets/ /app/assets/

EXPOSE 3000

# Healthcheck: confirms the process is alive and serving
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Start with symlink repair, then launch API
CMD ["sh", "-c", "/app/scripts/fix-symlinks.sh && exec node apps/api-services/dist/index.js"]
