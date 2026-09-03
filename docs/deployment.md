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

The clone is still needed because the (opt-in) `slskd-addon` profile bind-mounts
one in-repo file (`scripts/slskd-entrypoint.sh`). **Nothing is built locally** —
compose pulls the published server image, the published analysis sidecar image,
and (for acquisition) the published `ghcr.io/kevinch3/nicotind-slskd-addon`
image. Inlining the slskd entrypoint (making the install a pure "download N
files" flow, no clone) is the remaining gap — see
[oss-best-practices.md](oss-best-practices.md).

Soulseek acquisition is opt-in (`docker compose --profile slskd-addon up -d`).
The `slskd` container and the `slskd-addon` service both live behind that
profile; the addon connects to slskd and holds its credentials via `SLSKD_ADDON_*`
env vars on the addon container (`SLSKD_ADDON_SLSKD_USERNAME`/`_PASSWORD` for the
slskd web API, `SLSKD_ADDON_TOKEN` for core→addon auth). Core carries none of it.

### Volumes

| Volume          | Purpose                                                            |
| --------------- | ------------------------------------------------------------------ |
| `music`         | Shared music directory (slskd writes, NicotinD scans and streams)  |
| `nicotind-data` | NicotinD SQLite database, secrets, and artist-overrides            |
| `slskd-data`    | slskd application directory (`/app`, including config and state)   |
| `lidarr-config` | Lidarr database and config (metadata optimization)                 |

### Using a host directory for music

Replace the `music` volume with a bind mount in `docker-compose.override.yml`:

```yaml
services:
  nicotind:
    volumes:
      - /path/to/your/music:/data/music
  slskd:
    volumes:
      - /path/to/your/music:/data/music
```

## What the image contains (and what it deliberately doesn't)

The runtime install is `bun install --frozen-lockfile --ignore-scripts
**--production**`, and the runtime drops to `USER bun`.

Both are recent. Every workspace's `package.json` is copied into the production
stage so the lockfile can resolve the workspace graph — and without
`--production` the install pulled in all of their **devDependencies** too:
`@angular/cli`, Storybook and Compodoc from web, `electron-builder` from
desktop, `@capacitor/cli` from mobile, Playwright from e2e. None of it is
reachable from `bun run src/main.ts`; all of it shipped. Bun transpiles
TypeScript natively, so even `typescript` was dead weight.

Measured against the previously published image:

| | published (1.6 GB) | now |
|---|---|---|
| packages in the isolated store (`node_modules/.bun`) | 1,703 | **166** |
| `tar` | `7.5.13`, `6.2.1` | **absent** |
| `picomatch` | `2.3.2`, `4.0.3`, `4.0.4` | **absent** |
| `*.test.ts` / `*.spec.ts` files | 258 | **0** |
| runs as | `root` (uid 0) | `bun` (uid 1000) |
| image size | 1.6 GB | **896 MB** |

`tar` and `picomatch` are the carriers for the node-tar decompression-DoS
critical and five hardlink/symlink path-traversal highs — in a service that
extracts user-supplied zip archives. They arrived purely through build tooling.

> Count packages under `node_modules/.bun`, not the top level. Bun's isolated
> linker hoists only *direct* dependencies, so `ls node_modules` shows 12 in the
> old image and hides the other 1,691.

`USER bun` changes nothing for the documented deployment: `docker-compose.yml`
already sets `user: "1000:1000"`, and the base image's `bun` user is exactly
uid=1000 gid=1000. It stops the image *defaulting* to root for anyone running it
directly. The Dockerfile now creates `/data/nicotind` and `/data/music` owned by
`bun` before dropping — without that, a bare `docker run` with no volumes fails
at startup on `mkdir /data`, because `/` is root-owned. (The CI smoke test from
#620 caught exactly that, on its first real use.)

Tests are excluded via `.dockerignore` rather than a narrower `COPY`, so they
stay out of **both** stages.

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

### A green deploy is not proof the image shipped (issue #457)

`v0.1.329` released, its GHCR push 403'd, and the **deploy job still reported
success** — redeploying the host against the previous `release` image while
GitHub showed all-green. That version has no image to this day.

The cause was the deploy guard, not the transient 403. `deploy` tolerated
`needs.docker-merge.result == 'skipped'` unconditionally, because on a manual
`workflow_dispatch` the docker jobs legitimately don't run and the host should
just redeploy the current `release` images. But **a downstream job whose `needs`
failed also reports `skipped`**, so the condition could not distinguish
"nothing to build" from "the build broke".

Two changes close it:

1. **The `skipped` tolerance is scoped to `workflow_dispatch`.** On a tag push
   the docker jobs always run, so `skipped` there can only mean upstream
   failure, and the deploy is now correctly blocked.
2. **`docker-merge` verifies every tag it claimed actually resolves**
   (`vX.Y.Z`, `vX`, `release`) before the job succeeds — so a publish hole
   fails the release rather than being discovered months later by whoever pins
   to the missing version.

A **push retry was considered and not added**: it would need a third-party
retry action in the release path, which this repo avoids for the same
supply-chain reason it downloads a pinned `actionlint` binary instead of using
a wrapper action. A retry lowers the frequency of the transient failure; only
(1) stops a failed build from producing a green deploy, which is the actual
defect.

**Verifying a published tag by hand** (read-only, no auth needed):

```bash
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:kevinch3/nicotind:pull&service=ghcr.io" | jq -r .token)
curl -sI -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json" \
  "https://ghcr.io/v2/kevinch3/nicotind/manifests/v0.1.332"
```

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

#### Analysis sidecar runtime env vars (GPU memory, issue #224)

Two env vars govern the sidecar's GPU-memory footprint at *runtime* (no rebuild
needed, unlike `GPU=1`/`ANALYSIS_GPU_BUILD` which are build-time) — full
rationale in [audio-ml-enrichment.md](audio-ml-enrichment.md) "Measured GPU
behaviour":

- **`ANALYSIS_IDLE_RELEASE_SEC`** (default `900`) — seconds of no `/analyze`
  calls before the sidecar drops its warm-loaded models, reloading lazily
  (multi-second cost) on the next call. `0` or negative disables release. Set
  it on the `analysis` service's `environment:` in your override file.
- **`ANALYSIS_DESCRIPTOR_SECONDS`** (default `180`) — not GPU memory but CPU
  budget: the length of the track head the model-free `/descriptors` pass
  analyses (issue #641, ~5 s/track at 180, ~3 s at 90). Non-numeric or
  non-positive values fall back to the default rather than disabling the
  pass. See [audio-descriptors.md](audio-descriptors.md).
- **`TF_GPU_ALLOCATOR`** (unset by default) — set to `cuda_malloc_async` to try
  TF's stream-ordered allocator, which unlike the default (under
  `TF_FORCE_GPU_ALLOW_GROWTH=true`, already baked into the image) can return
  memory to the driver. **Not verified on real hardware in this repo** — it's
  a documented, commented-out override in `docker-compose.gpu.yml`; A/B it
  against a plain restart before trusting it in production.

### The separator sidecar image

`ghcr.io/kevinch3/nicotind-separator`, same tag semantics, published by the
`docker-separator` job — the karaoke vocal-separation sidecar
([vocal-separation.md](vocal-separation.md), issue #603). **GPU-only by contract**, so
unlike the analysis image the published one *is* the GPU build (torch from the cu126
index — the legacy lane that still ships Pascal `sm_60` kernels, which the cc 6.1 P4000 runs — plus a build-time
strict load of the baked checkpoint), and it is **pulled, not built**, by the
`docker-compose.gpu.yml` overlay, which is the only compose file that names it. A CPU
deploy never pulls it: without CUDA it would only ever report `unavailable`, and the API
keeps the basic center-cancel filter. Runtime knobs are commented in the overlay
(`SEPARATOR_IDLE_RELEASE_SEC`, `SEPARATOR_MAX_TRACK_SEC`, `SEPARATOR_ALLOW_CPU`). Idle
release here *stops the worker process*, so `nvidia-smi` shows 0 MiB for this container
between karaoke sessions and ~3.0 GB during one.

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

### Public signup (`NICOTIND_REGISTRATION`)

`registrationEnabled` gates `POST /register`; the login page hides its "create an
account" toggle from the public `GET /registration-status`. Both halves already
existed — what did not was any way to *set* the flag on a real deploy.

`.dockerignore` excludes `config/default.yml`, so the shipped image carries no
config file and the value fell through to the schema default — which was `true`.
A stock container therefore had public signup **open**, with no lever to close
it: there was no env override, unlike its `NICOTIND_ACQUISITION` /
`NICOTIND_HISTORY` siblings.

Two things changed. The schema default is now `false`, so the value a stock
deploy actually gets is closed rather than open; and the switch gained both an
env lever (`NICOTIND_REGISTRATION`) and an admin toggle. Accounts are created in
Admin → User Management, which — unlike `/register` — records a `user.create`
audit entry.

### The admin toggle, and why `configurable` means something different here

`RegistrationToggle` (`services/registration-toggle.ts`) is the persisted half:
`GET`/`PUT /api/admin/registration`, rendered as a switch on the Admin → User
Management card, audited as `registration.toggle`. Like `AcquisitionToggle` it
reads `app_settings` per call and is deliberately **not** memoized — a stale
cache would mean an admin closing signup and the route carrying on accepting
accounts.

The precedence rule is deliberately *not* acquisition's. There, `off` is a floor
and an admin may still restrict further. Here the env var is authoritative **when
present**, in either direction:

| `NICOTIND_REGISTRATION` | Effective value | `configurable` |
| --- | --- | --- |
| unset | the admin's stored choice, else the config default (closed) | `true` |
| `off` | closed | `false` |
| `on` | open | `false` |

One rule, both directions. An operator who pins the value in compose gets exactly
that value and a read-only control; an operator who leaves it unset hands the
decision to the admin UI. The shipped `docker-compose.yml` leaves it unset and
commented, so a stock deploy starts closed and is flippable from the UI.

A stored choice is still written while the env pins the value, so removing the
var later restores what the admin actually asked for rather than discarding it.

**The first-user bootstrap is exempt on purpose.** When the users table is empty
that account is minted `admin` and bypasses the switch, so a closed instance can
still bootstrap without an env edit. The accepted cost: an emptied users table (a
bad restore, a fresh volume, a wrong `dataDir`) re-opens self-registration on an
instance that was closed. The pure `registrationBlocked` predicate owns that
rule, and `auth.test.ts` pins both halves so the exemption stays a decision
rather than becoming an accident. If you would rather it be an absolute kill,
that is a one-line change to the predicate.

### Infra image pins

Images the app doesn't own are version-pinned so users can't drift on risky
components (Immich digest-pins theirs): `slskd` (already pinned),
`linuxserver/lidarr` (was `:latest` — a silent Lidarr major can break the API
client). The PO-token provider **is no longer one of them**: we build it (below).

**That pairing was enforced by `check:bgutil-pin` (issue #238), and the gate has
since been retired (issue #550).** It compared the pip plugin baked into the
*core* `Dockerfile` against `packages/pot-provider/Dockerfile`. Phase 4 moved
every downloader into its own addon image, so core stopped running yt-dlp at all
— the gate was guarding a copy nothing executed, and it retired together with
that copy.

The invariant itself is real and unchanged: plugin and provider must be the same
version or the service starts and YouTube downloads quietly stop working. It now
applies where the downloaders actually live — `nicotind-ytdlp-addon` and
`nicotind-spotdl-addon`, each baking its own `ARG BGUTIL_VERSION` against the
`nicotind-pot-provider` image it runs beside (issue #551).

#### The pin is published on the artifact

Those repos cannot read a file in this one, and a source-to-source check would
pass while the *published* image is stale — so the canonical version rides on
the image itself:

```
ghcr.io/kevinch3/nicotind-pot-provider   LABEL org.nicotind.bgutil.version=<version>
```

wired to `BGUTIL_VERSION` rather than repeated as a literal (a hardcoded label
would keep reporting the old version after a bump, so every consumer's check
would pass against a lie — `scripts/pot-provider-pin.test.ts` pins both that and
the stage-scoped `ARG` re-declaration, without which the label silently
interpolates to an empty string).

A consumer reads it without cloning anything:

```bash
docker buildx imagetools inspect ghcr.io/kevinch3/nicotind-pot-provider:release \
  --format '{{ index .Image.Config.Labels "org.nicotind.bgutil.version" }}'
```

**Consumer-side checks are not wired up yet.** The label only exists on images
built after this change, so each addon repo's CI assertion has to land once a
release has published a labelled provider. Until then the addon pins are still
guarded by nothing but a comment.

### We build the PO-token provider ourselves (issue #238)

The companion service was `brainicism/bgutil-ytdlp-pot-provider:X`, a
third-party image whose tag had to be kept in lockstep by hand with the pip
plugin baked into ours. It is now **our own image**,
`ghcr.io/kevinch3/nicotind-pot-provider`, built by the `docker-pot-provider` job
in `deploy.yml` — same tag scheme and cache scoping as `docker-analysis`, so
there is one shape to learn for our side-car images.

- **Built from pinned upstream source, not vendored.** `packages/pot-provider/Dockerfile`
  fetches the tagged tarball and mirrors upstream's own `server/Dockerfile` (node
  target), so a version bump is a tag change rather than a rewrite. Vendoring a
  whole Node service into this monorepo would make its dependency updates ours.
  Upstream is **GPL-3.0**, compatible with this project's AGPL-3.0-only.
- **The drift gate got better, then obsolete.** `check:bgutil-pin` first compared
  the pip pin against a *third-party image tag*, then against a second file in
  this repo — something we control. #550 then removed the core-side pin it read,
  and the gate with it; see the paragraph above for where the invariant moved.
- **Two deviations from upstream's Dockerfile**, both because ours must also
  build on a daemon without buildx: `/app` is chowned before dropping to the
  `node` user (upstream's BuildKit cache mount side-steps the ordering, so
  `npm ci` fails with EACCES without it), and `NPM_CONFIG_CACHE` points at a
  writable path instead of relying on that mount.
- **Verified end-to-end, not just "it builds"** — the failure mode this issue
  exists to prevent is a provider that *starts* while minting invalid tokens.
  Our image was run locally and asked for a real PO token against YouTube's live
  attestation endpoint; it returned a valid token with the same shape and
  `version: 1.3.1` as the upstream image did in the same test. To repeat it:

  ```bash
  docker build -t pot-test packages/pot-provider
  docker run -d --name pot-test -p 14417:4416 pot-test
  curl -s http://127.0.0.1:14417/ping
  curl -s -X POST http://127.0.0.1:14417/get_pot \
    -H 'content-type: application/json' -d '{"content_binding":"dQw4w9WgXcQ"}'
  ```

  A `poToken` + `expiresAt` in the response means the provider is genuinely
  talking to YouTube. Falling back to upstream's image is a one-line compose
  override if ours ever regresses.

### Pinning a version

`docker-compose.yml` uses `image: ghcr.io/kevinch3/nicotind:${NICOTIND_VERSION:-release}`.
Create a `.env` file next to the compose file:

```bash
# .env
NICOTIND_VERSION=v0.1.230
```

Unset (default) = track `release`.

## Unsafe defaults being removed in 0.4.0

Two defaults that ship today are dangerous, and both leave in **0.4.0**. They are
announced first — a running instance logs a warning at boot naming each one — so
an operator gets a release in which the thing still works and the message says
what to do. See [SECURITY.md](../SECURITY.md) and issue #612.

### `/var/run/docker.sock` is bind-mounted by default

`docker-compose.yml` mounts the Docker socket into the `nicotind` container to
support the admin log viewer (`packages/api/src/routes/system.ts`). **This is
host-root-equivalent privilege.** The `:ro` flag does not mitigate it — the
Docker API is read-write over that socket regardless of how the file is mounted.
So any RCE or SSRF anywhere in the API escalates directly to root on the host,
in a service that fetches remote cover art, parses untrusted audio tags, shells
out to `ffmpeg`/`fpcalc` and extracts user-supplied zip archives.

**In 0.4.0 it is removed from `docker-compose.yml`.** If you want the log viewer,
copy `docker-compose.override.example.yml` to `docker-compose.override.yml` and
uncomment the mount. Without it the feature degrades cleanly: the route returns
`503 Docker socket not available` rather than failing obscurely.

> Compose **merges** an override into the base file, but a *list* in the override
> **replaces** the base list instead of appending. If you declare `volumes:` in
> your override you must re-list the music and data mounts too, or they vanish.
> The example file says this at the top for the same reason.

### Addon tokens default to `change-me`

`SLSKD_ADDON_TOKEN`, `YTDLP_ADDON_TOKEN` and `SPOTDL_ADDON_TOKEN` all default to
the literal `change-me` (`docker-compose.yml`), and nothing currently fails if an
operator never overrides them. `findInsecureDefaults`
(`packages/api/src/services/insecure-defaults.ts`) warns about this at boot, after the
ready handshake, and is never fatal — it reads `addon_registrations.token`, not env
vars, because a registered placeholder is a live credential where an unused one in
compose harms nobody. Anything that can reach an addon on the Docker
network can then drive it.

**In 0.4.0 the addons refuse to start without a real token** (`${VAR:?}` in
compose gives this for free). Set them in your `.env` now:

```bash
SLSKD_ADDON_TOKEN=$(openssl rand -hex 32)
YTDLP_ADDON_TOKEN=$(openssl rand -hex 32)
SPOTDL_ADDON_TOKEN=$(openssl rand -hex 32)
```

then re-register the addons under Extensions so core stores the new token.

**The boot warning checks what is registered, not what is configured.** Core
never sees those env vars — they belong to the addon containers, which live in
their own repos. What it can see is `addon_registrations.token`, which is the
credential an admin actually registered. That is also the signal that matters: a
placeholder sitting unused in a compose file harms nobody; a registered one is
live.

## Upgrade

```bash
docker compose pull
docker compose up -d
```

### What the automated deploy pulls (issue #606)

The `deploy` job derives its pull list from the resolved compose config rather
than restating it:

```sh
images=$(docker compose config --images | grep "^ghcr\.io/kevinch3/" | sort -u)
[ -n "$images" ] || { echo "no images resolved — refusing to deploy" >&2; exit 1; }
echo "$images" | xargs -n1 docker pull
```

The empty-list check is load-bearing rather than defensive: the step does not set
`pipefail`, so a pipeline's status is only its last command's. A failing
`docker compose config` would flow an empty string into `xargs -r`, which does
nothing and exits 0 — a silent skip that deploys stale images behind a green run,
which is the same failure this whole section exists to prevent.

It used to pull a hardcoded `nicotind analysis`, which meant the three addon
images and the pot-provider were **never** pulled. That is worse than it sounds:
`docker compose up -d` will not recreate a container whose image reference is
unchanged, so a rebuilt `:latest` addon keeps running the old bytes indefinitely.
A green release (v0.3.38) once shipped with `/api/health` reporting the new
version while the spotdl addon container was still the build from 8 hours
earlier — the #457 "green deploy, previous version" shape, one layer down.
Deriving the list means adding a service to compose cannot silently miss the
deploy; `scripts/check-deploy-images.test.ts` is the drift guard.

Two deliberate constraints:

- **Scoped to our own registry.** A bare `docker compose pull` would also pull
  `linuxserver/lidarr` and `slskd/slskd`, coupling every release to third-party
  registries that have nothing to do with it.
- **A pull failure aborts the deploy** (`set -e`), never skips. A missing image
  must be loud — that is the whole lesson of #457.

It also self-scopes per host: a streaming-only deployment resolves no addon
services, so none are pulled.

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

## A missing asset 404s; a stale build reloads itself

The SPA catch-all serves `index.html` only for **navigation** requests
(`shouldServeSpaIndex`). A request for a static asset that is not on disk gets a
**404**, never the HTML shell with a 200.

That distinction is not cosmetic (#925). A tab left open across a deploy holds a
build whose chunk hashes no longer exist. Answering its request for
`chunk-XYZ.js` with `index.html` made the browser parse HTML as an ES module and
report *"error loading dynamically imported module"* — an error naming the
bundler, when the truth was that the build was stale. Every deploy created this
for anyone mid-session, and the message pointed nowhere near the cause.

With an honest 404 the client can recognise it: every lazy route is wrapped in
`lazy()` (`lib/stale-chunk.ts`), which reloads **once** to pull the current
build. The single-shot guard is the load-bearing part — if a chunk is genuinely
missing rather than merely stale, an unguarded retry is an endless refresh loop,
far worse than the dead button it replaced. The marker is cleared on successful
bootstrap so a later deploy in the same session recovers too.

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

Resolves to **`nicotind` + `analysis` only** — slskd and Lidarr are dropped,
saving their RAM, disk and attack surface. (The bgutil PO-token provider used to
need dropping here too; since #550 it is not part of core's stack at all.) The
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

### Job layout (why there are three gate jobs, not one)

`ci.yml` ran one `ci` job holding every static gate, the web unit tests **and** the
Storybook catalog gates, serially on one runner. Measured on two consecutive master runs
it took **10m09** (and **14m16** on a bad one) while `e2e` finished in 4m55,
`desktop-package` in 57s and `docker` in 9s — every other job idled, and the workflow's
wall clock was `ci` plus the 20s `release`. The end-to-end commit→deployed time was that
plus `deploy.yml`'s ~5m38.

The gates are now three jobs that run beside each other:

| Job | Holds | Why separate |
| --- | --- | --- |
| `ci` | actionlint, typecheck, lint, format, the `check:*` gates, API/core unit tests | fast, no browser, no minutes-long step |
| `web-test` | the Angular vitest suite | 135s of CPU sharing nothing with the static gates |
| `storybook` | `build:storybook` + the merged render-smoke/axe gate | browser-driven; needs only `storybook-static`, never the `ng build` dist |

`Build (web)` left the gate jobs entirely — `e2e`, `desktop-package` and `desktop-smoke`
each already run `ng build`, so the production build is still covered three times over.

Two invariants keep the split honest, both enforced by `bun run check:ci-parity`:

- **Every gate job's checks stay reachable from `bun run verify`.** The script's
  `GATE_JOBS` list replaced a hardcoded `'ci'`; without that, moving a gate into a new job
  would have quietly dropped it from parity coverage — the same drift that shipped three
  times before (#273, #376, and one more after them).
- **Every gate job blocks `release`.** A gate that is not in the `release` job's `needs` is
  advisory: it can fail while the tag is cut anyway. That is the #457 shape, so it is a
  check rather than a habit.

### Caching

Nothing was cached before — `actions/cache` appeared zero times across all three
workflows, so all 11 `bun install` invocations re-downloaded the dependency tree and every
browser job re-fetched Chromium (22s typically, but **4m24** on one observed run).
`setup-bun` caches the bun binary only, never `~/.bun/install/cache`. Both are cached now,
and `bun-version` is pinned via a workflow-level `BUN_VERSION` rather than `latest`:
a drifting toolchain makes the cache key unstable and a green run unreproducible. The bun
key hashes `bunfig.toml` alongside `bun.lock` because `[install] peer = false` changes the
resolved tree.

Caching the Playwright browser does **not** cover the `--with-deps` apt-get half, which is
where that 4m24 came from. If it recurs, the next step is splitting `playwright
install-deps` from `playwright install chromium`.

### The rest

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

### A master push must never cancel another master push (issue #360)

`ci.yml`'s top-level `concurrency: { group: ci-${{ github.ref }},
cancel-in-progress: true }` exists so a superseded PR push cancels its
predecessor's in-flight run. But the `release` job's own version-bump commit
is itself a push to `master` — the same `github.ref` the currently-running
workflow is on — so it starts a second run in the *same* group, and GitHub
cancels the first (still-wrapping-up) run out from under itself, immediately
after its `release` job already succeeded. Observed on PR #351: the
originating run showed overall conclusion `cancelled` in the Actions UI while
every one of its jobs, including `release`, reported `success` — the release
itself (tag, GitHub Release, changelog) landed intact, but it read as "merged
but produced no release" at a glance. Unlucky timing could cancel the
`release` job mid-push instead of after, which would be a real failure, not
a cosmetic one. Fixed by scoping `cancel-in-progress` off for `master`:
pushes to `master` run sequentially and can never cancel each other, while a
PR branch keeps the original supersede-and-cancel behavior.

**But not cancelling was only half of it (issue #906).** `cancel-in-progress: false`
governs the *running* member of a group. It says nothing about the *pending* one, and
GitHub keeps exactly one pending run per group — so a third master push evicted the
second before it ever started. Four master commits in five days ran no CI of their own,
two of them `fix:`. Nothing went unreleased (the `release` job deliberately releases the
true remote tip, so an evicted commit is absorbed by the next run), but the evicted
commit's *content* was never examined by a run that executed: the sidecar image filter
diffs `github.event.before`, so the successor run diffed only its own commit. v0.5.71
shipped a change to `ci.yml` — a path that filter itself calls image-affecting — with both
image smoke builds reporting `skipped`.

The fix is one group per master **commit**
(`ci-${{ github.ref == 'refs/heads/master' && github.sha || github.ref }}`), which makes
eviction structurally impossible rather than merely discouraged. That deliberately lets
two master merges run at once; what must *not* run at once is `release`, so it carries its
own constant job-level group (`ci-release-master`, queue-never-cancel) restoring exactly
the serialization the shared workflow group used to provide, and nothing else. The trade
is runner minutes during a merge burst. Pinned by `scripts/ci-concurrency.test.ts`.

### Two releases must never deploy to the host at once (issue #768)

`ci.yml` above serializes *per branch*, which is the right key for a branch's
own runs. `deploy.yml` needs a different one: it serializes per **host**, and it
used to group on `github.sha`.

A tag push sets `github.sha` to the commit the tag points at, so two releases
are two different commits, therefore two different concurrency groups, therefore
no mutual exclusion whatsoever. The grouping only ever deduplicated re-runs of a
single commit — a manual re-run, or a second tag on one commit. Everything it
looked like it was protecting was unprotected.

The `deploy` job SSHes to the host and runs `docker compose pull` + `up -d`. Two
releases cut close together — exactly what happens when several PRs land in one
sitting — reached that step concurrently, racing container restarts against each
other, with the second deploy able to pull an image the first was mid-way
through starting. A second, quieter race sat in `docker-merge`: its manifest
push claims `:release` and `:vX` as well as `:vX.Y.Z`, and those two are shared
mutable tags, so concurrent releases fought over which one they finally pointed
at.

Fixed with a constant group and queueing:

```yaml
concurrency:
  group: deploy-host
  cancel-in-progress: false
```

Two details are load-bearing.

`cancel-in-progress: false`, because abandoning a deploy mid-`up -d` leaves the
host half-applied — strictly worse than waiting for it. This is the same shape
`storybook-pages.yml` already uses for its own single-destination publish.

The group is **workflow-level, not on the `deploy` job alone**. Serializing only
the job looks tighter — expensive per-platform builds would still overlap — but
`deploy` waits on `docker-merge`, so a later tag whose build finished first
would deploy first and then be overwritten by the earlier release still in
flight. That is a version downgrade wearing a green check, which is the #457
failure shape. Ordering is worth more here than build overlap.

`scripts/deploy-concurrency.test.ts` guards all three properties. It parses the
workflow rather than grepping it, so a `group:` sitting in a comment cannot
satisfy the assertion, and it rejects any `${{ … }}` in the group rather than
just the one `github.sha` spelling — a gate that only knew the old spelling
would pass on `github.ref_name`, which is equally per-release.

`#755` fixed the adjacent half of this problem (a release cut for nothing
releasable); it did not touch the case where two genuine releases are in flight
at once.
