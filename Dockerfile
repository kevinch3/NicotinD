# Stage 1: Build web UI
FROM imbios/bun-node:1.3.14-22.22.3-debian AS web-builder
WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY packages/api/package.json packages/api/
COPY packages/cli/package.json packages/cli/
COPY packages/core/package.json packages/core/
COPY packages/addon-sdk/package.json packages/addon-sdk/
COPY packages/service-manager/package.json packages/service-manager/
COPY packages/lidarr-client/package.json packages/lidarr-client/
COPY packages/web/package.json packages/web/
COPY packages/e2e/package.json packages/e2e/
# Workspace members: only their package.json is needed for the lockfile to
# resolve (the native android/ios shells are never built in the image, but
# mobile depends on capacitor-now-playing so its manifest must be present).
COPY packages/mobile/package.json packages/mobile/
COPY packages/capacitor-now-playing/package.json packages/capacitor-now-playing/
COPY packages/capacitor-apk-update/package.json packages/capacitor-apk-update/
COPY packages/capacitor-tv-channels/package.json packages/capacitor-tv-channels/
# desktop (Electron) is never built in the image, but it's a workspace member,
# so its manifest must be present for the frozen lockfile to resolve.
COPY packages/desktop/package.json packages/desktop/
# Skip postinstall scripts — sharp's binary download fails in this stage and
# generate-icons is never run in Docker (outputs are committed).
RUN bun install --frozen-lockfile --ignore-scripts

COPY packages/core/ packages/core/
COPY packages/addon-sdk/ packages/addon-sdk/
COPY packages/web/ packages/web/
COPY tsconfig.json ./
# build-changelog.ts reads repo-root CHANGELOG.md → static JSON for the changelog
# modal; without it the web build silently emits an empty changelog.
COPY CHANGELOG.md ./
RUN cd packages/web && bun run build

# Stage 2: Production server
FROM oven/bun:1.3.14 AS production
WORKDIR /app

# OCI labels: `source` links the GHCR package to this repo (auto-connects the
# package page + inherits repo visibility/README on ghcr.io).
LABEL org.opencontainers.image.source="https://github.com/kevinch3/NicotinD" \
      org.opencontainers.image.description="NicotinD — self-hosted music acquisition + streaming server" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

# Install curl (healthchecks), ffmpeg (transcode + enrichment), docker CLI (log
# streaming via mounted socket), and libchromaprint-tools, which provides the
# `fpcalc` binary AcoustID identify spawns (issue #548 — without it every
# identify returns `fpcalc-missing`, whose "install libchromaprint-tools"
# remediation a container operator cannot act on).
#
# No python3/pip, no Deno, no yt-dlp/spotdl (issue #550): phase 4 moved every
# downloader into its own addon image, each of which brings that stack itself.
# Core spawns none of them — `dockerfile-runtime-binaries.test.ts` re-derives
# that premise, so restoring an in-process downloader fails there and says so.
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates ffmpeg libchromaprint-tools && \
    rm -rf /var/lib/apt/lists/*
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker

# Copy all packages (web needs package.json for workspace resolution)
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages/core/ packages/core/
COPY packages/addon-sdk/ packages/addon-sdk/
COPY packages/lidarr-client/ packages/lidarr-client/
COPY packages/service-manager/ packages/service-manager/
COPY packages/api/ packages/api/
COPY packages/cli/ packages/cli/
COPY packages/web/package.json packages/web/
COPY packages/e2e/package.json packages/e2e/
COPY packages/mobile/package.json packages/mobile/
COPY packages/capacitor-now-playing/package.json packages/capacitor-now-playing/
COPY packages/capacitor-apk-update/package.json packages/capacitor-apk-update/
COPY packages/capacitor-tv-channels/package.json packages/capacitor-tv-channels/
COPY packages/desktop/package.json packages/desktop/
COPY src/ src/

# --ignore-scripts (matching the web-builder stage): a transitive sharp@0.32.6
# — pulled in only by @capacitor/assets, a mobile-icon dev tool never run in this
# server image — has an `install` script that downloads a libvips binary, and that
# download fails in this stage. The runtime's own image work uses sharp@0.35
# (native binary ships as the `@img/sharp-linux-*` packages, resolved from the
# lockfile — no postinstall), so skipping scripts here is safe. Lifecycle scripts
# (incl. the root `prepare: husky` hook) have no place in a runtime image anyway.
RUN bun install --frozen-lockfile --ignore-scripts

# Copy pre-built web UI
COPY --from=web-builder /app/packages/web/dist packages/web/dist

EXPOSE 8484

# /api/health is the real unauthenticated liveness probe (same target the
# compose healthcheck uses); /api/auth/login was a stale pre-health-route probe.
HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD curl -f http://localhost:8484/api/health || exit 1

CMD ["bun", "run", "src/main.ts"]
