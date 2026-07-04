FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY package.json tsconfig.base.json ./
COPY packages/logger/package.json packages/logger/tsconfig.json packages/logger/
COPY packages/shared-types/package.json packages/shared-types/tsconfig.json packages/shared-types/
COPY apps/ops-agent/package.json apps/ops-agent/tsconfig.json apps/ops-agent/
RUN pnpm install --frozen-lockfile
COPY packages/ packages/
COPY apps/ops-agent/ apps/ops-agent/
RUN pnpm exec tsc -b apps/ops-agent/tsconfig.json

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
EXPOSE 8181
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/ops-agent ./apps/ops-agent
COPY package.json pnpm-workspace.yaml ./
CMD ["node", "apps/ops-agent/dist/index.js"]
