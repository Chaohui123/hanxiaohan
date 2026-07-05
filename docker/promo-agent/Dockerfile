FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN echo "ignore-scripts=true" >> .npmrc && echo "verify-deps-before-run=false" >> .npmrc
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY package.json tsconfig.base.json ./
COPY packages/logger/package.json packages/logger/tsconfig.json packages/logger/
COPY packages/shared-types/package.json packages/shared-types/tsconfig.json packages/shared-types/
COPY packages/feishu-bot/package.json packages/feishu-bot/tsconfig.json packages/feishu-bot/
COPY apps/promo-agent/package.json apps/promo-agent/tsconfig.json apps/promo-agent/
RUN pnpm install --no-frozen-lockfile --ignore-scripts --config.verify-deps-before-run=false
COPY packages/ packages/
COPY apps/promo-agent/ apps/promo-agent/
RUN for pkg in logger shared-types feishu-bot; do \
      ./node_modules/.bin/tsc -p packages/$pkg/tsconfig.json --noEmitOnError false || true; \
    done && \
    ./node_modules/.bin/tsc -p apps/promo-agent/tsconfig.json --noEmitOnError false || true

RUN for f in packages/*/package.json; do sed -i "s|\"./src/index.ts\"|\"./dist/index.js\"|" $f; done
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
EXPOSE 8182
EXPOSE 9101
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/promo-agent ./apps/promo-agent
COPY package.json pnpm-workspace.yaml ./
CMD ["node", "apps/promo-agent/dist/index.js"]
