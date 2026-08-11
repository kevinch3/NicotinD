# The slskd acquisition addon (docs/acquisition-addon-protocol.md).
# Build from the repo root: docker build -f packages/slskd-addon/Dockerfile .
FROM oven/bun:1.3.14

WORKDIR /app

# Workspace install scoped to what the addon needs (core + slskd-client).
COPY package.json bun.lock tsconfig.json ./
COPY packages/core/package.json packages/core/tsconfig.json ./packages/core/
COPY packages/slskd-client/package.json ./packages/slskd-client/
COPY packages/slskd-addon/package.json packages/slskd-addon/tsconfig.json ./packages/slskd-addon/
RUN bun install --production --ignore-scripts

COPY packages/core/src ./packages/core/src
COPY packages/slskd-client/src ./packages/slskd-client/src
COPY packages/slskd-addon/src ./packages/slskd-addon/src

ENV SLSKD_ADDON_DB=/data/slskd-addon.sqlite \
    SLSKD_ADDON_DOWNLOADS_DIR=/data/downloads \
    SLSKD_ADDON_PORT=8585

EXPOSE 8585

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.SLSKD_ADDON_PORT ?? 8585) + '/addon/v1/health'); if (!r.ok) process.exit(1); const b = await r.json(); if (b.ok !== true) process.exit(1);"

CMD ["bun", "run", "packages/slskd-addon/src/main.ts"]
