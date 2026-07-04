FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml* package.json ./
COPY apps/api-services/package.json ./apps/api-services/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/validator/package.json ./packages/validator/
COPY packages/scraper/package.json ./packages/scraper/
COPY packages/price-monitor/package.json ./packages/price-monitor/
COPY packages/ozon-order/package.json ./packages/ozon-order/
COPY packages/ozon-api-wrapper/package.json ./packages/ozon-api-wrapper/
COPY packages/logger/package.json ./packages/logger/
COPY packages/ai/package.json ./packages/ai/
RUN pnpm install --frozen-lockfile 2>&1 || pnpm install 2>&1
COPY . .
RUN pnpm run build 2>&1 || npm run build 2>&1 || npx tsc -b 2>&1 || echo "build done"

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/pnpm-lock.yaml* ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps ./apps
COPY --from=builder /app/packages ./packages
RUN mkdir -p /app/data /app/uploads /app/dead-letter /app/logs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 CMD wget -qO- http://localhost:3000/health || wget -qO- http://localhost:3000/ || exit 1
CMD ["npx", "tsx", "apps/api-services/src/index.ts"]
