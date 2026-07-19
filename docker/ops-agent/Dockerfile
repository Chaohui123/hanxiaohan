FROM node:22-alpine AS builder
ENV npm_config_registry=https://registry.npmmirror.com \
    COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN echo "ignore-scripts=true" >> .npmrc && echo "verify-deps-before-run=false" >> .npmrc
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY package.json tsconfig.base.json ./
COPY packages/logger/package.json packages/logger/tsconfig.json packages/logger/
COPY packages/shared-types/package.json packages/shared-types/tsconfig.json packages/shared-types/
COPY packages/feishu-bot/package.json packages/feishu-bot/tsconfig.json packages/feishu-bot/
COPY packages/ai/package.json packages/ai/tsconfig.json packages/ai/
COPY packages/cache/package.json packages/cache/tsconfig.json packages/cache/
COPY packages/embedding/package.json packages/embedding/tsconfig.json packages/embedding/
COPY apps/ops-agent/package.json apps/ops-agent/tsconfig.json apps/ops-agent/
RUN pnpm install --no-frozen-lockfile --ignore-scripts --config.verify-deps-before-run=false
COPY packages/ packages/
COPY apps/ops-agent/ apps/ops-agent/
RUN for pkg in logger shared-types feishu-bot ai cache embedding; do \
      ./node_modules/.bin/tsc -p packages/$pkg/tsconfig.json --noEmitOnError false || true; \
    done && \
    ./node_modules/.bin/tsc -p apps/ops-agent/tsconfig.json --noEmitOnError false || true
RUN for f in packages/*/package.json; do sed -i "s|\"./src/index.ts\"|\"./dist/index.js\"|" $f; done

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache ca-certificates
EXPOSE 8181
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/ops-agent ./apps/ops-agent
COPY package.json pnpm-workspace.yaml ./
CMD ["node", "apps/ops-agent/dist/index.js"]
