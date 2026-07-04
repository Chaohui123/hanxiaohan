FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

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
COPY apps/api-services/package.json apps/api-services/tsconfig.json apps/api-services/

RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/ apps/

RUN pnpm exec tsc -b

FROM node:22-alpine
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps ./apps
COPY package.json tsconfig.base.json ./

EXPOSE 3000
CMD ["node", "--experimental-sqlite", "apps/api-services/dist/index.js"]
