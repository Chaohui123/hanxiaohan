FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN apt-get update && apt-get install -y --no-install-recommends chromium && rm -rf /var/lib/apt/lists/* && npm install --omit=dev --no-audit --no-fund
ENV OZONE_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
COPY server.js ./
ENV PORT=8080
CMD ["node", "server.js"]
