# ============================================================
# ONZO Production Dockerfile — multi-stage build
# Stage 1: builder (compiles TypeScript + installs deps)
# Stage 2: runner (production runtime, minimal size)
# ============================================================

FROM node:22-alpine AS builder
WORKDIR /app

# Build dependencies for native modules (better-sqlite3, sharp)
RUN apk add --no-cache python3 make g++

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace config + lockfile first (layer caching)
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY package.json tsconfig.base.json ./

# Copy only package.json files for dependency install (cache-efficient)
COPY apps/api-services/package.json apps/api-services/tsconfig.json apps/api-services/
COPY packages/shared-types/package.json packages/shared-types/tsconfig.json packages/shared-types/
COPY packages/validator/package.json packages/validator/tsconfig.json packages/validator/
COPY packages/scraper/package.json packages/scraper/tsconfig.json packages/scraper/
COPY packages/price-monitor/package.json packages/price-monitor/tsconfig.json packages/price-monitor/
COPY packages/ozon-order/package.json packages/ozon-order/tsconfig.json packages/ozon-order/
COPY packages/ozon-api-wrapper/package.json packages/ozon-api-wrapper/tsconfig.json packages/ozon-api-wrapper/
COPY packages/logger/package.json packages/logger/tsconfig.json packages/logger/
COPY packages/ai/package.json packages/ai/tsconfig.json packages/ai/

# Install dependencies (pnpm handles workspace linking)
RUN pnpm install --frozen-lockfile

# Copy full source
COPY apps/ apps/
COPY packages/ packages/

# Build TypeScript — fail on error, no fallback
RUN pnpm run build

# ============================================================
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Install runtime system dependencies
# - chromium + deps: Playwright browser automation
# - ffmpeg: video processing (video-russianizer)
# - wget: health check
RUN apk add --no-cache \
    chromium \
    nss freetype harfbuzz ca-certificates ttf-freefont \
    ffmpeg \
    wget \
    && rm -rf /var/cache/apk/*

ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Enable pnpm for runtime (needed for tsx execution)
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy built artifacts from builder
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps ./apps
COPY --from=builder /app/packages ./packages

# Create runtime directories
RUN mkdir -p /app/data/backups /app/data/browser /app/logs /app/uploads /app/dead-letter /app/data/tmp-images

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "apps/api-services/dist/index.js"]
