# Deployment (Docker) — install, upgrade, rollback

How NicotinD is packaged and deployed for self-hosters. Patterned on the
practices of mature self-hosted projects (Immich in particular): a **published,
versioned, multi-arch server image** with explicit tag semantics, compose as the
one install path, and build-from-source demoted to an override.

## Install

```bash
git clone https://github.com/kevinch3/NicotinD.git
cd NicotinD
docker compose up -d
# open http://localhost:8484 → setup wizard
```

The clone is still needed because the compose stack references in-repo files
(`scripts/slskd-entrypoint.sh`, the `packages/analysis` sidecar build). The
**server itself is not built locally** — compose pulls the published image.
Publishing the analysis sidecar image too (making the install a pure
"download 2 files" flow, no clone) is a roadmap item — see
[oss-best-practices.md](oss-best-practices.md).

## The published image

`ghcr.io/kevinch3/nicotind`, multi-arch (`linux/amd64` + `linux/arm64`), built
by `.github/workflows/deploy.yml` on every `v*` release tag:

- the `docker` job builds each arch **on a native runner** (`ubuntu-latest` /
  `ubuntu-24.04-arm` — no QEMU: Bun's JIT is unreliable under emulation) and
  pushes **by digest** only;
- the `docker-merge` job stitches the digests into one multi-arch manifest and
  moves the tags. Because tagging is a single atomic step at the end, a
  half-failed release can never move `release` to a partial image.

### Tag semantics

| Tag | Meaning |
| --- | --- |
| `vX.Y.Z` | exact release, immutable in practice — pin this to hold or roll back |
| `vX` | major metatag: latest release within major `X` |
| `release` | stable metatag: latest tagged release; the compose default |

There is deliberately **no `latest` tag**. `release` is the explicit
equivalent, and it can only ever point at a tagged release (Immich's
`release`/`vN` metatag convention; their docs likewise steer users away from
`:latest`).

### Pinning a version

`docker-compose.yml` uses `image: ghcr.io/kevinch3/nicotind:${NICOTIND_VERSION:-release}`.
Create a `.env` file next to the compose file:

```bash
# .env
NICOTIND_VERSION=v0.1.230
```

Unset (default) = track `release`.

## Upgrade

```bash
docker compose pull
docker compose up -d
```

Schema migrations run automatically on boot. Skim the release notes
(CHANGELOG.md / the GitHub Release page) before upgrading — anything marked
`!`/`BREAKING CHANGE` requires attention. Be careful with unattended
auto-updaters (Watchtower-style) for the same reason.

## Rollback

Pin the previous version in `.env` and `docker compose up -d`. Caveat: the
SQLite schema is **forward-migrated on boot** — an older server may not
understand a newer schema. Treat downgrades as best-effort and take a backup of
the data volume before major upgrades (see Backups below).

## Build from source

For development or forks with no registry, add the build key in
`docker-compose.override.yml` (see `docker-compose.override.example.yml`):

```yaml
services:
  nicotind:
    build: .
```

With both `image:` and `build:` present, `docker compose up --build` builds
locally and tags the result under the image name.

## One-time GHCR setup (maintainer note)

GHCR packages start **private** even on public repos. After the first
publishing release: GitHub → the `nicotind` package → Package settings →
Change visibility → Public. Until then, anonymous `docker pull` (including the
production deploy host) fails with denied/not-found; alternatively
`docker login ghcr.io` on the host with a read-only PAT. The
`org.opencontainers.image.source` label in the Dockerfile links the package to
the repo automatically.

## Healthcheck

`GET /api/health` → `{ ok: true, version: "X.Y.Z" }` — unauthenticated
liveness probe used by the Dockerfile `HEALTHCHECK`, the compose healthcheck,
the desktop sidecar handshake, and the e2e web server wait. `version` is
informational (verify what a deploy shipped with one `curl`); clients must only
rely on `ok`.

## Data layout & backups

Everything stateful lives in the `nicotind-data` volume (`/data/nicotind` in
the container): `nicotind.db` (SQLite, WAL mode), `secrets.json`
(auto-generated, mode 0600), `cover-cache/`, `artist-overrides/`. Music lives
in the `music` volume.

Minimal backup today: stop the container (or accept WAL-copy caveats) and copy
the data volume; the music dir is plain files. A proper scheduled backup
(`VACUUM INTO` snapshot + pruning, admin-triggered restore — the Home
Assistant backup model) is a roadmap item in
[oss-best-practices.md](oss-best-practices.md).

## Resource notes

- The compose stack publishes only port 8484; everything else is on an
  internal bridge network.
- No memory/CPU limits are set by default. On constrained hosts add limits in
  your override file (`mem_limit`, `cpus`) — the heavy consumers are library
  scans and ffmpeg-based enrichment (whose concurrency is admin-tunable in
  Admin → Library processing).
- **Security**: the `/var/run/docker.sock` mount in `docker-compose.yml` grants
  the container host-root-equivalent privilege; it exists only for the admin
  log-streaming feature. Remove it unless you need that (see the comment in the
  compose file).

## CI coverage

`ci.yml`'s `docker` job lints both compose files on every push/PR
(`docker compose config -q`) and rebuilds the image (amd64, no push) whenever a
container input (`Dockerfile`, `.dockerignore`, `docker-compose*.yml`, the two
workflows) changes — so a broken image build fails the PR, not the release.
Its GHA cache scope matches the release build's amd64 scope, so master-push
builds warm the release cache. The `release` job in `ci.yml` requires the
`docker` job, so a red image build blocks tagging.
