# NicotinD's own build of the bgutil YouTube PO-token provider.
#
# why: the provider ran as a third-party image whose version had to be kept in
# lockstep by hand with the `bgutil-ytdlp-pot-provider` pip plugin baked into the
# nicotind image — a mismatch silently breaks YouTube downloads (issue #238).
# #289 made `BGUTIL_VERSION` drive both halves and added a CI drift gate; this
# builds the server itself so it ships under our GHCR and our release cadence.
#
# Upstream is GPL-3.0, compatible with this project's AGPL-3.0-only.
#
# Source is fetched at the pinned tag rather than vendored: vendoring a whole
# Node service into this monorepo would put its dependency updates on us, and
# the pin is already the single source of truth #289 established.
ARG BGUTIL_VERSION=1.3.1

FROM node:25-bookworm-slim AS source
ARG BGUTIL_VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -fsSL "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/${BGUTIL_VERSION}.tar.gz" \
  | tar -xz --strip-components=1

# The three stages below mirror upstream's own server/Dockerfile (node target).
# Kept deliberately close to it so a version bump is a tag change, not a rewrite.
FROM node:25-bookworm-slim AS install
# WORKDIR creates /app owned by root, so chown it before dropping privileges —
# otherwise `npm ci` can't mkdir node_modules. (Upstream gets away without this
# because its BuildKit cache mount side-steps the ordering.)
RUN mkdir -p /app && chown node:node /app
USER node
WORKDIR /app
# Upstream uses BuildKit cache mounts for the npm cache; this build must also
# work on a plain (non-buildx) daemon, so point the cache somewhere the `node`
# user can always write instead of depending on that mount existing.
ENV NPM_CONFIG_CACHE=/tmp/.npm
COPY --from=source --chown=node:node /src/server/package.json /src/server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM install AS build_node
RUN npm ci --no-audit --no-fund
COPY --from=source --chown=node:node /src/server/types/ types/
COPY --from=source --chown=node:node /src/server/tsconfig.json ./
COPY --from=source --chown=node:node /src/server/src/ src/
RUN npx tsc

FROM install AS server
COPY --from=build_node /app/build /app/build
EXPOSE 4416
ENTRYPOINT ["/usr/local/bin/node", "build/main.js"]
