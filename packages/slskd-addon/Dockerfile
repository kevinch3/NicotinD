# The slskd acquisition addon (docs/acquisition-addon-protocol.md).
# Build from the repo root: docker build -f packages/slskd-addon/Dockerfile .
FROM oven/bun:1.3.14

WORKDIR /app

# bun resolves the ENTIRE workspace graph from the root lockfile, so every
# member's package.json must be present even though the addon only imports
# core + slskd-client at runtime — a "scoped" subset fails with "workspace
# dependency not found". Mirror the root Dockerfile's manifest copy; --production
# still keeps the installed dependency set to prod-only.
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages/api/package.json packages/api/
COPY packages/cli/package.json packages/cli/
COPY packages/core/package.json packages/core/
COPY packages/addon-sdk/package.json packages/addon-sdk/
COPY packages/service-manager/package.json packages/service-manager/
COPY packages/slskd-client/package.json packages/slskd-client/
COPY packages/slskd-addon/package.json packages/slskd-addon/
COPY packages/lidarr-client/package.json packages/lidarr-client/
COPY packages/web/package.json packages/web/
COPY packages/e2e/package.json packages/e2e/
COPY packages/mobile/package.json packages/mobile/
COPY packages/capacitor-now-playing/package.json packages/capacitor-now-playing/
COPY packages/capacitor-apk-update/package.json packages/capacitor-apk-update/
COPY packages/capacitor-tv-channels/package.json packages/capacitor-tv-channels/
COPY packages/desktop/package.json packages/desktop/
RUN bun install --production --ignore-scripts

COPY packages/core/src ./packages/core/src
COPY packages/addon-sdk/src ./packages/addon-sdk/src
COPY packages/slskd-client/src ./packages/slskd-client/src
COPY packages/slskd-addon/src ./packages/slskd-addon/src

ENV SLSKD_ADDON_DB=/data/slskd-addon.sqlite \
    SLSKD_ADDON_DOWNLOADS_DIR=/data/downloads \
    SLSKD_ADDON_PORT=8585

EXPOSE 8585

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.SLSKD_ADDON_PORT ?? 8585) + '/addon/v1/health'); if (!r.ok) process.exit(1); const b = await r.json(); if (b.ok !== true) process.exit(1);"

CMD ["bun", "run", "packages/slskd-addon/src/main.ts"]
