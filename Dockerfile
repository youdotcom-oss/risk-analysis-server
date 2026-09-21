# Multi-stage build for the You.com risk analysis MCP server (Bun-native).
# The runtime is pure Bun: bun:sqlite, Bun.cron, and web-standard HTTP.

FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY src ./src

# SQLite lives on the mounted volume so sweeps persist across restarts.
ENV RISK_DB_PATH=/data/risk.sqlite
VOLUME ["/data"]

# HTTP entry (JWT + cron engine). For local stdio transport, override:
#   docker run ... risk-analysis-server bun src/stdio.ts
EXPOSE 3000
ENTRYPOINT ["bun"]
CMD ["src/server.ts"]
