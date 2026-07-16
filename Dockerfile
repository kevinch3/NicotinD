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
COPY packages/e2e/package.json packages/e2e/
# Workspace members: only their package.json is needed for the lockfile to
# resolve (the native android/ios shells are never built in the image, but
# mobile depends on capacitor-now-playing so its manifest must be present).
COPY packages/mobile/package.json packages/mobile/
COPY packages/capacitor-now-playing/package.json packages/capacitor-now-playing/
# desktop (Electron) is never built in the image, but it's a workspace member,
# so its manifest must be present for the frozen lockfile to resolve.
COPY packages/desktop/package.json packages/desktop/
# Skip postinstall scripts — sharp's binary download fails in this stage and
# generate-icons is never run in Docker (outputs are committed).
RUN bun install --frozen-lockfile --ignore-scripts

COPY packages/core/ packages/core/
COPY packages/web/ packages/web/
COPY tsconfig.json ./
# build-changelog.ts reads repo-root CHANGELOG.md → static JSON for the changelog
# modal; without it the web build silently emits an empty changelog.
COPY CHANGELOG.md ./
RUN cd packages/web && bun run build

# Stage 2: Production server
FROM oven/bun:1.3.14 AS production
WORKDIR /app

# Install curl (healthchecks), ffmpeg, docker CLI (log streaming via mounted
# socket), python3/pip (for yt-dlp + spotdl URL acquisition), and unzip (for
# the Deno installer below).
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates ffmpeg python3 python3-pip unzip && \
    rm -rf /var/lib/apt/lists/*
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker

# Deno: yt-dlp needs a JS runtime to solve YouTube's player signature
# challenges — without one, many YouTube downloads fail outright.
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

# yt-dlp + spotdl power the /api/acquire URL downloader. Installed system-wide
# via pip (Debian externally-managed env needs --break-system-packages). They
# land on PATH as `yt-dlp` / `spotdl`, matching the default acquire.binaryPath.
# --upgrade keeps yt-dlp at the latest release each image build — YouTube
# breaks older versions continuously. bgutil-ytdlp-pot-provider is the yt-dlp
# plugin that fetches PO tokens from the bgutil companion service (see
# docker-compose.yml); it applies to spotdl too (same python env).
RUN pip3 install --no-cache-dir --break-system-packages --upgrade yt-dlp spotdl bgutil-ytdlp-pot-provider

# Copy all packages (web needs package.json for workspace resolution)
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages/core/ packages/core/
COPY packages/slskd-client/ packages/slskd-client/
COPY packages/lidarr-client/ packages/lidarr-client/
COPY packages/service-manager/ packages/service-manager/
COPY packages/api/ packages/api/
COPY packages/cli/ packages/cli/
COPY packages/web/package.json packages/web/
COPY packages/e2e/package.json packages/e2e/
COPY packages/mobile/package.json packages/mobile/
COPY packages/capacitor-now-playing/package.json packages/capacitor-now-playing/
COPY packages/desktop/package.json packages/desktop/
COPY src/ src/

RUN bun install --frozen-lockfile

# Copy pre-built web UI
COPY --from=web-builder /app/packages/web/dist packages/web/dist

EXPOSE 8484

HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD curl -f http://localhost:8484/api/auth/login || exit 1

CMD ["bun", "run", "src/main.ts"]
