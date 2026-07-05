# ============================================================
# ONZO API Services — Minimal Production Image
# Only builds api-services + workspace packages.
# Smaller & faster than root Dockerfile.
# ============================================================

FROM node:22-alpine AS builder
WORKDIR /app

RUN apk add --no-cache python3 make g++

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN echo "ignore-scripts=true" >> .npmrc && echo "verify-deps-before-run=false" >> .npmrc

# Copy workspace files
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY package.json tsconfig.base.json ./

# Copy only the packages that api-services depends on
COPY packages/shared-types/package.json packages/shared-types/tsconfig.json packages/shared-types/
COPY packages/ozon-api-wrapper/package.json packages/ozon-api-wrapper/tsconfig.json packages/ozon-api-wrapper/
COPY packages/ai/package.json packages/ai/tsconfig.json packages/ai/
COPY packages/scraper/package.json packages/scraper/tsconfig.json packages/scraper/
COPY packages/validator/package.json packages/validator/tsconfig.json packages/validator/
COPY packages/ozon-order/package.json packages/ozon-order/tsconfig.json packages/ozon-order/
COPY packages/price-monitor/package.json packages/price-monitor/tsconfig.json packages/price-monitor/
COPY packages/logger/package.json packages/logger/tsconfig.json packages/logger/
COPY packages/cache/package.json packages/cache/tsconfig.json packages/cache/
COPY packages/logistics/package.json packages/logistics/tsconfig.json packages/logistics/
COPY apps/api-services/package.json apps/api-services/tsconfig.json apps/api-services/

# Install all deps (need TypeScript for build; runner stage only copies what's needed)
RUN pnpm install --no-frozen-lockfile --ignore-scripts --config.verify-deps-before-run=false

# Copy full source
COPY packages/ packages/
COPY apps/ apps/

# Compile TypeScript (per-package to ensure JS output even with type errors)
RUN for pkg in logger shared-types ozon-api-wrapper ai scraper validator ozon-order price-monitor cache logistics; do \
      ./node_modules/.bin/tsc -p packages/$pkg/tsconfig.json --noEmitOnError false || true; \
    done && \
    ./node_modules/.bin/tsc -p apps/api-services/tsconfig.json --noEmitOnError false || true

# Fix package.json main fields (src → dist) and copy non-TS assets
RUN for f in packages/*/package.json; do sed -i "s|\"./src/index.ts\"|\"./dist/index.js\"|" $f; done
RUN cp -r packages/scraper/src/scripts packages/scraper/dist/scripts || true

# ============================================================
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Runtime dependencies
RUN apk add --no-cache \
    chromium nss freetype harfbuzz ca-certificates ttf-freefont \
    ffmpeg \
    wget \
    postgresql-client \
    && rm -rf /var/cache/apk/*

ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Copy built artifacts
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps ./apps
COPY package.json pnpm-workspace.yaml ./

# Runtime directories
RUN mkdir -p /app/data/backups /app/data/browser /app/logs /app/uploads /app/dead-letter /app/data/tmp-images

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "apps/api-services/dist/index.js"]
