FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web-dashboard/package.json ./apps/web-dashboard/
RUN pnpm install --frozen-lockfile
COPY apps/web-dashboard ./apps/web-dashboard
RUN pnpm --filter web-dashboard build

FROM nginx:alpine
COPY --from=builder /app/apps/web-dashboard/dist /usr/share/nginx/html
COPY apps/web-dashboard/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
