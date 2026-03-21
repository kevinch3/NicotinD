# Stage 1: Build web UI
FROM oven/bun:1 AS web-builder
WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY packages/api/package.json packages/api/
COPY packages/cli/package.json packages/cli/
COPY packages/core/package.json packages/core/
COPY packages/navidrome-client/package.json packages/navidrome-client/
COPY packages/service-manager/package.json packages/service-manager/
COPY packages/slskd-client/package.json packages/slskd-client/
COPY packages/web/package.json packages/web/
RUN bun install --frozen-lockfile

COPY packages/core/ packages/core/
COPY packages/web/ packages/web/
COPY tsconfig.json ./
RUN cd packages/web && bun run build

# Stage 2: Production server
FROM oven/bun:1 AS production
WORKDIR /app

# Install curl (healthchecks) — tailscale CLI communication via local API socket
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Copy all packages (web needs package.json for workspace resolution)
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages/core/ packages/core/
COPY packages/slskd-client/ packages/slskd-client/
COPY packages/navidrome-client/ packages/navidrome-client/
COPY packages/service-manager/ packages/service-manager/
COPY packages/api/ packages/api/
COPY packages/cli/ packages/cli/
COPY packages/web/package.json packages/web/
COPY src/ src/

RUN bun install --frozen-lockfile

# Copy pre-built web UI
COPY --from=web-builder /app/packages/web/dist packages/web/dist

EXPOSE 8484

HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD curl -f http://localhost:8484/api/auth/login || exit 1

CMD ["bun", "run", "src/main.ts"]
