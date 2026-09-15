# syntax=docker/dockerfile:1
# Glass Pro Suite - image produksi untuk Coolify / Docker
FROM node:24-bookworm-slim AS deps
WORKDIR /app
# better-sqlite3 memakai binary prebuilt; toolchain hanya cadangan bila prebuilt tidak tersedia
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 STORAGE_DIR=/app/storage
WORKDIR /app
# curl dipakai HEALTHCHECK (Coolify menjalankan health check di dalam container); gosu untuk drop privilege
RUN apt-get update && apt-get install -y --no-install-recommends curl gosu && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /app/storage && chown -R node:node /app && chmod +x /app/docker-entrypoint.sh
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 CMD curl -fsS http://localhost:3000/api/health || exit 1
# Entrypoint jalan sebagai root hanya untuk memperbaiki kepemilikan volume /app/storage, lalu turun ke user node
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
