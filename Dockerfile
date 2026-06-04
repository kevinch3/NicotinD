# Stage 1: Build web UI
FROM imbios/bun-node:1.3.14-22.22.3-debian AS web-builder
WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY packages/api/package.json packages/api/
COPY packages/cli/package.json packages/cli/
COPY packages/core/package.json packages/core/
COPY packages/service-manager/package.json packages/service-manager/
COPY packages/slskd-client/package.json packages/slskd-client/
COPY packages/lidarr-client/package.json packages/lidarr-client/
COPY packages/web/package.json packages/web/
RUN bun install --frozen-lockfile

COPY packages/core/ packages/core/
COPY packages/web/ packages/web/
COPY tsconfig.json ./
RUN cd packages/web && bun run build

# Stage 2: Production server
FROM oven/bun:1.3.14 AS production
WORKDIR /app

# Install curl (healthchecks), ffmpeg, docker CLI (log streaming via mounted
# socket), and python3/pip (for yt-dlp + spotdl URL acquisition).
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates ffmpeg python3 python3-pip && \
    rm -rf /var/lib/apt/lists/*
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker

# yt-dlp + spotdl power the /api/acquire URL downloader. Installed system-wide
# via pip (Debian externally-managed env needs --break-system-packages). They
# land on PATH as `yt-dlp` / `spotdl`, matching the default acquire.binaryPath.
RUN pip3 install --no-cache-dir --break-system-packages yt-dlp spotdl

# Copy all packages (web needs package.json for workspace resolution)
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages/core/ packages/core/
COPY packages/slskd-client/ packages/slskd-client/
COPY packages/lidarr-client/ packages/lidarr-client/
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
