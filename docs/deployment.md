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

The clone is still needed because the compose stack bind-mounts one in-repo
file (`scripts/slskd-entrypoint.sh`). **Nothing is built locally** — compose
pulls the published server image and the published analysis sidecar image.
Inlining the slskd entrypoint (making the install a pure "download 2 files"
flow, no clone) is the remaining gap — see
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

### The analysis sidecar image

`ghcr.io/kevinch3/nicotind-analysis`, same tag semantics, published by the
`docker-analysis` job. **amd64 only** — essentia-tensorflow ships x86_64-only
wheels, so this sidecar has never been runnable on arm64; on an arm64 host
remove/disable the `analysis` service (everything degrades gracefully — only
the audio-features enrichment task pauses). GPU inference still builds from
source with `GPU=1`, opt-in via the **`docker-compose.gpu.yml` overlay** (see
[audio-ml-enrichment.md](audio-ml-enrichment.md)).

#### GPU passthrough — the `docker-compose.gpu.yml` overlay

GPU access for the analysis sidecar lives in its own opt-in overlay
(`docker-compose.gpu.yml`), **not** in `docker-compose.override.yml`. Enable it
per-command or persistently via `COMPOSE_FILE`:

```bash
# per-command
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
# or persistently, in .env:
COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml
```

**Why a separate overlay, not the override file.** The device reservation below
is a *hard* reservation: if the host can't satisfy the GPU injection the
`analysis` container fails to start (there is no runtime-level CPU fallback — the
image's CPU fallback only applies to a container that actually started). Keeping
this out of `docker-compose.override.yml` means a host GPU / `nvidia-persistenced`
problem can only affect deploys that explicitly opt in — it can never wedge the
default CPU deploy, and recovering never means hand-editing the override file that
also holds your essential bind mounts. (This is exactly the failure the v0.1.257/258
deploys hit: the override requested the GPU while the host's legacy runtime had no
`nvidia-persistenced` socket, so the whole stack wouldn't start.)

#### GPU passthrough on the host — `nvidia-persistenced` vs CDI

A host with an NVIDIA GPU usually ends up with the `nvidia-container-runtime`
registered as an extra Docker runtime, and the overlay opts a service into it the
modern way:

```yaml
analysis:
  deploy:
    resources:
      reservations:
        devices:
          - driver: nvidia
            count: 1
            capabilities: [gpu]
```

Under the hood, Docker then asks the NVIDIA runtime to inject the GPU. The
NVIDIA runtime ships in two modes (see
[the official docs](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/cdi-support.html)):

- **legacy** (`mode = "legacy"`, the default on older toolkit installs) — the
  runtime bind-mounts `/run/nvidia-persistenced/socket` into the container. If
  `nvidia-persistenced` is **not running on the host** (the service is enabled
  by default but stops on host reboot, package upgrades, driver updates, etc.),
  that mount fails and the container can't start. Two fixes:
  1. `sudo systemctl enable --now nvidia-persistenced` on the host (the
     legacy runtime works as soon as the service is back), or
  2. switch to **CDI mode** (recommended): the runtime reads CDI
     specifications from `/etc/cdi` and `/var/run/cdi` and **does not** need
     `nvidia-persistenced`. Enable with:
     ```bash
     sudo nvidia-ctk config --in-place --set nvidia-container-runtime.mode=cdi
     sudo systemctl restart docker
     ```
     The toolkit's `nvidia-cdi-refresh` systemd service keeps the
     `/var/run/cdi/nvidia.yaml` spec up to date automatically.

The symptom of either missing fix is a one-line failure at the very end of
`docker compose up --build -d`:

```
Error response from daemon: failed to create task for container: ...
  OCI runtime create failed: runc create failed: ...
  failed to fulfil mount request: open /run/nvidia-persistenced/socket:
  no such file or directory
```

This surfaces the *other* symptom NicotinD has run into in the wild: the host
opted into the GPU overlay (or, historically, carried the device block in its
override) while a `CUDA_VISIBLE_DEVICES=""` workaround disabled the GPU at
runtime anyway. The two are redundant; pick one. If you don't actually need GPU
access (the API's `audio-features` task tolerates the CPU fallback fine), simply
**don't enable `docker-compose.gpu.yml`** — the default deploy runs the published
CPU image and never asks the host for a GPU, so it isn't subject to the
`nvidia-persistenced` runtime dance at all.

### Acquisition runtime toggle (issue #235)

`config.acquisitionEnabled` shipped **env-only**, read once at boot, so turning
acquisition off meant editing the environment and restarting. The issue left this
open with the note that *"boot-constructed services can't tear down live"* —
which overstated the problem:

- The two unattended pollers (watchlist, auto-acquire) **already re-check
  `isAcquisitionEnabled()` every tick**, so they self-disable the moment the value
  changes. Nothing needs tearing down. They only had to be *started* whenever the
  **environment** permits, rather than when the runtime flag is on, so a runtime
  *enable* has something to wake up.
- What genuinely had to change is three capture sites, from `boolean` to
  `() => boolean`: the gate middleware, `searchRoutes`, and `authRoutes` (`/me`).
  Each still accepts a plain boolean, so existing callers and tests are unaffected.

`AcquisitionToggle` (`services/acquisition-toggle.ts`) reads `app_settings` per
call and is deliberately **not memoized** — a stale cache here means an admin
turns acquisition off and the routes carry on serving it.

**The environment is a hard floor, not a default.** `NICOTIND_ACQUISITION=off`
cannot be lifted from the UI: a deployment shipped without slskd (the
streaming-only compose profile) must not be re-enablable by whoever happens to
hold an admin account. `GET`/`PUT /api/admin/acquisition` return `configurable:
false` in that case so the UI can render the control read-only instead of
offering something that silently does nothing. Flips are audit-logged.

### Infra image pins

Images the app doesn't own are version-pinned so users can't drift on risky
components (Immich digest-pins theirs): `slskd` (already pinned),
`linuxserver/lidarr` (was `:latest` — a silent Lidarr major can break the API
client), and `brainicism/bgutil-ytdlp-pot-provider`, which must stay **in
step with the pip-installed plugin pinned in the Dockerfile**.

**That pairing is now enforced, not just documented (issue #238).** The two
halves live in different files built by different systems — the pip plugin in
the `Dockerfile` (baked into our image by CI) and the companion service tag in
`docker-compose.yml` (resolved at deploy time) — and a mismatch does not fail
loudly: the service starts and YouTube downloads quietly stop working. Two
changes: **`BGUTIL_VERSION` overrides both** (a build-arg in the Dockerfile, a
`${BGUTIL_VERSION:-…}` interpolation in compose) so an operator bumps one
value, and **`bun run check:bgutil-pin`** runs in CI and fails when the two
baked defaults drift apart. It is a gate rather than a report because there is
exactly one correct answer — the strings match or they don't — so there is no
false-positive class to cry wolf with.

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

> **⚠️ Un-pin after you recover — a left-behind pin silently freezes every future
> auto-deploy.** The release `deploy` job (`deploy.yml`) does `git reset --hard
> <tag>` + `docker compose pull`, but it **never touches the gitignored `.env`**.
> So a `NICOTIND_VERSION=<old>` pin keeps the host on `<old>` through every
> subsequent release — the deploy looks green but the app never moves. When the
> incident is resolved, delete the pin line and `docker compose pull nicotind &&
> docker compose up -d nicotind` so the host follows `:release` again.

### Incident runbook — the 2026-07 GPU deploy wedge

**Symptom.** A release deploy on the prod host left the stack down; `docker
compose up` ended with:

```
OCI runtime create failed: runc create failed: ...
failed to fulfil mount request: open /run/nvidia-persistenced/socket: no such file or directory
```

**Cause.** The host's local `docker-compose.override.yml` requested the analysis
GPU via a `deploy.resources.reservations.devices` block. That is a *hard* device
reservation — with the host's nvidia runtime in `legacy` mode and
`nvidia-persistenced` down (its socket gone after a driver upgrade/reboot), the
analysis container couldn't start **at all**, wedging the stack. The nicotind
image itself was fine.

**Recovery (what actually fixes it).**
1. Roll the app back only if you must — pin `NICOTIND_VERSION` in `.env`. (The
   image was never the problem here, so this step was precautionary.)
2. Stop requesting the GPU: don't enable `docker-compose.gpu.yml`, and remove any
   GPU device block from the host override. `docker compose up -d` — the CPU
   image runs healthy.
3. **Un-pin** per the warning above so auto-deploys resume.

**Guardrails now in place so it can't recur.**
- GPU is opt-in via a **separate** `docker-compose.gpu.yml` overlay, never the
  override that holds essential bind mounts. A GPU / `nvidia-persistenced`
  problem can only affect deploys that explicitly opt in — never the default CPU
  deploy. See "GPU passthrough — the overlay" above.
- Before re-enabling GPU, confirm the host can inject it (`nvidia-smi` works +
  CDI mode **or** `nvidia-persistenced` up) — see "GPU passthrough on the host".

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

## Update check + version history

The server polls the GitHub releases API at most once per 24h (1h backoff on
failure, `NICOTIND_UPDATE_CHECK=off` to disable — the poll sends nothing but
the request itself) and caches the newest release in the DB
(`services/update-check.ts`). `GET /api/admin/update-check` serves the cache —
current vs latest version, `updateAvailable`, release URL — plus the
`version_history` table (every version this server has ever booted, recorded
at startup; Immich's version-history pattern, invaluable for support). Admin →
System shows the row ("Server: vX — up to date / Update available") with a
"Check now" button (`?refresh=1` forces a poll). Applying an update stays
`docker compose pull && up -d` (above) — the server never updates itself.

## Data layout & backups

Everything stateful lives in the `nicotind-data` volume (`/data/nicotind` in
the container): `nicotind.db` (SQLite, WAL mode), `secrets.json`
(auto-generated, mode 0600), `cover-cache/`, `artist-overrides/`. Music lives
in the `music` volume.

Backups are automatic: a daily `VACUUM INTO` snapshot of the DB + secrets
lands under `<dataDir>/backups`, pruned to the newest 7, with an Admin
"Back up now" trigger — see [backup-restore.md](backup-restore.md) for the
schedule, configuration (`NICOTIND_BACKUP*`), and the manual restore steps.
Copy the backups directory off-host for disaster protection; the music dir is
plain files (rsync it).

## Streaming-only profile (deployment-wide acquisition kill-switch, #235)

Acquisition is opt-in three ways that compose: per-plugin (default-off in the
registry), per-user (the role ladder — `listener` can't acquire), and now
**deployment-wide**. Setting `NICOTIND_ACQUISITION=off` (env, or `acquisitionEnabled: false`
in `config/default.yml`) turns the **whole acquisition module off for the entire
install** — a genuinely lighter "streaming/library-only" deploy with no
slskd/Lidarr sidecars needed. The library scanner + streaming stack are untouched
(that's the point).

What "off" does — one authoritative `config.acquisitionEnabled` flag consulted on
both sides (env default; an admin runtime toggle is a deliberate follow-up, see
below):

- **Server (hard-off, 404).** `requireAcquisitionEnabledMiddleware(config.acquisitionEnabled)`
  (`services/plugins/gate.ts`) is mounted after auth on every acquisition route
  group — `/api/acquire`, `/api/discography`, `/api/watchlist`, `/api/archive`,
  `/api/spotify`, `/api/sources`, `/api/downloads` — and returns **404** ("as if
  the routes don't exist", the cleanest lightweight posture) when off. Orthogonal
  to the per-user `requireAcquirer` role gate and the per-plugin
  `requireAcquisitionMiddleware`. `/api/search` is deliberately **not** 404'd (it
  stays a library search) — instead `searchRoutes(registry, config.acquisitionEnabled)`
  skips its network fan-out for **every** user, exactly as it already does for a
  listener.
- **Background services skip.** The unattended pollers never start: `watchlistSvc.start()`
  and the auto-acquisition loop are both guarded on `config.acquisitionEnabled`
  (and their per-sweep `isAcquisitionEnabled` callback folds it in too).
- **Web hides everything.** `GET /api/auth/me` returns `acquisitionEnabled`;
  `AuthService.canAcquire()` is `serverAcquisitionEnabled() && role-can-acquire`,
  so the single flag cascades to the Downloads nav item, the `acquireGuard` on
  `/downloads`, and every acquisition surface on the (now acquisition-only, #227)
  Search page — which shows a "browse your Library instead" empty state when the
  user can't acquire.

- **Extensions hides its Acquisition section.** With the switch off, listing
  acquisition extensions would offer a toggle that cannot do anything (every
  route 404s, the pollers never start), and the page's "nothing is downloaded
  until you enable an extension here" framing is actively wrong. The section is
  hidden and replaced by a note naming the env var
  (`data-testid="extensions-acquisition-off"`). Metadata + connectivity
  extensions still render — they are unrelated to acquisition.

### Actually running lighter: `docker-compose.streaming-only.yml`

The env var turns the module off; this file stops *paying* for the sidecars that
exist only to serve it:

```bash
docker compose -f docker-compose.yml -f docker-compose.streaming-only.yml up -d
```

Resolves to **`nicotind` + `analysis` only** — slskd, Lidarr and the bgutil
PO-token provider are dropped, saving their RAM, disk and attack surface. The
`analysis` sidecar deliberately stays: audio enrichment is a *library* feature,
not an acquisition one.

Two coupled mechanics, and either alone is broken — both learned by running it:

- The acquisition sidecars get `profiles: ["acquisition"]`, a profile this file
  never activates, so they are simply not started.
- `nicotind`'s `depends_on` must be dropped, or compose refuses the whole
  project (*"service nicotind depends on undefined service slskd"*). Compose
  **merges** `depends_on` across files rather than replacing it, so
  `depends_on: []` silently keeps the base entries — it needs
  **`depends_on: !reset null`** (compose v2.24+).

CI lints this combination alongside the other compose files.

**Still not covered (follow-up on #235):** an admin **runtime** toggle
(persisted, no restart) — env-only remains the confidently-safe subset, because
the background services are constructed at boot and can't be cleanly torn down
live.

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

## The release job (orphan-tag-proof tagging)

`ci.yml`'s `release` job cuts the `vX.Y.Z` tag whose push fires this whole
`deploy.yml` pipeline. It bumps via `commit-and-tag-version` and pushes the
`chore(release)` commit + tag to master. Two properties make it safe to re-run
and impossible to wedge:

- **Atomic push.** The commit + tag go up with `git push --atomic
  --follow-tags origin HEAD:refs/heads/master`. If a concurrent merge advanced
  master, the branch update is rejected _and the tag is rejected with it_ — so
  a half-failed push can never leave a tag on the remote without its commit on
  master.
- **Self-healing orphan detection.** Before releasing, the job resolves the
  next version and, if that tag already exists, checks whether its commit is an
  **ancestor of master**. Reachable ⇒ genuinely published ⇒ skip. _Not_
  reachable ⇒ it's an orphan from an old half-failed push ⇒ delete it (remote +
  local) and re-cut the release from real master. A bounded retry re-syncs to
  the true tip so a merge racing the release is retried, never orphaned.

### Why this exists (2026-07-23 incident)

The predecessor pushed with a **non-atomic** `git push --follow-tags`. During
PR #188's release a concurrent advance rejected the `master` update
`non-fast-forward`, but the `v0.1.244` tag still landed — pointing at a
`chore(release)` commit that never reached master (an "orphan tag"). The old
idempotency guard was `tag exists → skip`, so from that moment every master
push resolved the next version to the still-uncreated `0.1.244`, saw the orphan
tag, and **silently exited green** without tagging. No tag ⇒ no `deploy.yml`
run: releases froze for a day (PRs #189/#196/#197 merged with green CI but shipped
nothing) while every CI run looked healthy. Because `softprops/action-gh-release`
merges into a tag's release and the `docker` job overwrites by tag, re-cutting
a version is safe — so the self-heal simply deletes the orphan and re-releases.
