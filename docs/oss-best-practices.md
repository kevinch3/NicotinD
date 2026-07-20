# OSS self-hosting best practices — adoption roadmap

NicotinD shares its deployment/community profile with the two benchmark
self-hosted projects: **Immich** (photos) and **Home Assistant** (automation).
This doc is the prioritized roadmap of their practices worth adopting, produced
from a structured comparison (2026-07). Each item: what it is, where the
pattern comes from, the NicotinD-specific proposal, and rough effort
(S ≤ 1 day, M ≈ days, L ≈ weeks).

**Already shipped from this review** (see [deployment.md](deployment.md)):
published multi-arch GHCR image with `release`/`vX`/`vX.Y.Z` tag semantics, no
`:latest`; compose defaults to the published image with build-from-source as an
override; deploy host pulls instead of builds; Dockerfile HEALTHCHECK fixed to
`/api/health`; `/api/health` reports the running version; compose lint + image
build in CI gating releases.

**Where NicotinD is already at or ahead of the benchmarks** — don't copy what
we already beat: zero-config first-run wizard + auto-generated secrets (HA
still asks more of a new user), OpenAPI + Swagger UI out of the box, a
four-role ladder (`listener < user < refiner < admin` — Immich has two roles),
conventional-commit release automation with a generated changelog, opt-in
Sentry with aggregated processing-failure events, plugin capability gating with
live re-init.

---

## 1. Deployment (P1)

- ~~**Publish the `analysis` sidecar image**~~ — **done**: published as
  `ghcr.io/kevinch3/nicotind-analysis` (amd64 only — essentia-tensorflow has
  x86_64-only wheels; arm64 hosts disable the service). GPU stays a source
  build (`--build-arg GPU=1`) via override.
- ~~**Pin infra images**~~ — **done**: `lidarr` pinned to a version tag,
  `bgutil` provider image pinned in step with the pip plugin pin in the
  Dockerfile (bump together). Digest-pinning + a Renovate-style bump flow
  remains open. (S)
- **Inline the slskd entrypoint** — the last reason the install needs a git
  clone is the `scripts/slskd-entrypoint.sh` bind mount; inlining it (compose
  `command`/config or baking a tiny image) makes the install a true
  "download compose + .env" flow, two files like Immich. (S)
- **ffmpeg hardware-acceleration compose overlay** — Immich ships
  `hwaccel.transcoding.yml` with named profiles (`nvenc`, `qsv`, `vaapi`, …)
  that users `extends:` into the main file; the base install stays identical
  for everyone. NicotinD's transcode paths (lossless→Opus, vocal-mute, disk
  transcode cache) are ffmpeg-only today; an overlay + codec flag gets
  low-power boxes (N100s, NAS) real headroom. (M)
- **arm64 status**: shipped for the server image via native
  `ubuntu-24.04-arm` runners (proven green on v0.1.230). The analysis sidecar
  is amd64-only by upstream constraint (see above).

## 2. Runtime robustness (P1)

- **`--check-config` + safe mode** — HA validates config on boot, offers an
  explicit pre-restart check command, and boots a minimal "recovery mode" on
  bad config (also force-enabled by dropping a `safe-mode` sentinel file in
  the config dir). NicotinD proposal: a `bun run src/main.ts --check-config`
  flag that runs exactly the boot-time Zod validation + slskd/Lidarr
  reachability probes and exits non-zero; on invalid config, boot the API +
  library (streaming keeps working) with acquisition/plugins disabled instead
  of crash-looping; honor a `<dataDir>/safe-mode` sentinel that skips plugin
  init and background loops for troubleshooting. (M)
- ~~**Backup & restore, first-class**~~ — **done** (v1): nightly marker-guarded
  `VACUUM INTO` snapshot + secrets copy under `<dataDir>/backups`, keep-N
  pruning, admin list/trigger routes + Admin "Back up now" block, documented
  manual restore — see [backup-restore.md](backup-restore.md). Open
  extensions: downloadable archive, artist-overrides inclusion,
  backup-before-update hook. (M)
- **Retention/purge policy (bounded detail, unbounded aggregates)** — HA's
  recorder purges detailed history nightly (`purge_keep_days`, default 10) but
  keeps downsampled statistics forever, and VACUUMs on a schedule. NicotinD
  analogs: the disk transcode cache (currently unbounded — add an LRU size
  cap), `scan_cache` rows for deleted paths, completed
  `acquisition_jobs`/`album_jobs` detail, and future play-history (keep
  per-play rows N days, keep per-song/per-day aggregates forever). One nightly
  maintenance tick in the existing processor loop. (M)
- **Watchdog + health-state taxonomy** — HA's supervisor auto-restarts crashed
  components and documents every degraded state ("unhealthy"/"unsupported")
  with causes/remedies. NicotinD: the embedded-mode `ServiceManager` should
  restart a crashed slskd child with backoff (it already owns the lifecycle),
  and `/api/system/status` should expose one explicit taxonomy
  (`healthy | degraded | unhealthy` + reasons: slskd down, analysis sidecar
  down, disk near-full, config invalid) with a docs section per state — the
  Admin panel then renders one honest health strip instead of scattered
  booleans. (M)

## 3. Server management (P2)

- ~~**Update check + in-app "update available"**~~ — **done** (v1): daily
  cached GitHub-releases poll (`NICOTIND_UPDATE_CHECK=off` opt-out, 1h failure
  backoff), `GET /api/admin/update-check`, Admin → System row with "Check
  now". Open extensions: release-channel setting, non-admin toast. See
  [deployment.md](deployment.md) "Update check".
- ~~**`version_history` table**~~ — **done**: written on boot
  (`recordBootVersion`), served by the update-check route.
- **Release-notes discipline: a Breaking changes section** — both projects
  surface backward-incompatible changes as a dedicated, mandatory release-note
  section. NicotinD: `.versionrc.json` already routes `feat!`/`BREAKING
  CHANGE:` into the changelog — add a `BREAKING` section header to the
  template, and adopt HA's deprecation SOP for config keys / API routes:
  announce with the target removal version, log a runtime warning naming the
  replacement, remove no sooner than N releases later. (S process + discipline)
- **Repairs-style action center** — HA surfaces "you must act" items
  (failed migrations, deprecations) as structured in-app Repair issues, not
  log lines. NicotinD already has admin surfaces that are 80% of this
  (fragmentation check, untracked downloads, processing-failure tallies);
  unify them under one Admin "Attention" list with per-item dismiss/fix
  actions, and route future deprecation warnings there. (M)

## 4. User roles & multi-user (P2)

NicotinD's four-role ladder already exceeds Immich (admin/user). Gaps worth
closing:

- **Admin audit log** — who deleted/merged/renamed/acquired what, when. The
  curator role (`refiner`) makes destructive actions multi-user; today they're
  only in server logs. One `audit_log` table written by the `requireCurator`/
  `requireAdmin` mutation routes + a read-only Admin page. Pairs with the
  existing `ConfirmService` destructive-action flow. (M)
- **User-facing roles doc** — [roles.md](roles.md) is engineering-facing;
  admins provisioning accounts need a capability matrix ("what does `refiner`
  let my roommate do?"). Short table in README or the docs site later. (S)
- **Per-user limits (optional)** — listener-role quotas (e.g. max offline
  preserve size) if shared instances grow; not needed for the
  household-scale deployments of today. (M, deferred)
- **OAuth** — already designed in [oauth-auth.md](oauth-auth.md); slots into
  this ladder unchanged (auto-created users land as `listener`/`user` per
  admin default). (L, existing plan)

## 5. API & SDK (P3)

- **Freeze `/api/v1` at 1.0** — routes are unversioned today; that's fine
  pre-1.0 (Immich only adopted compatibility guarantees at their 2.0). When a
  stability promise is made, mount the router at `/api/v1` with `/api` kept as
  an alias for one deprecation window. (S at the right moment)
- **Generated TS SDK from the existing OpenAPI doc** — Immich generates
  `@immich/sdk` from their spec and consumes it in web, CLI, and e2e, so
  clients can't drift. NicotinD already serves `/openapi.json`
  (`@hono/zod-openapi`) but the web app hand-writes its `api-types.ts`.
  Generate a workspace package (oazapfts or hono's RPC client) consumed by
  `packages/web` + `packages/e2e`; drift then fails typecheck. Precondition:
  finish annotating the remaining routes with `.openapi()` schemas. (L)

## 6. Community & adoption (P3)

- **GitHub community health files** — `.github/` currently holds only the two
  workflows. Add: `CONTRIBUTING.md` (distill the real conventions from
  CLAUDE.md: quality gates, conventional commits, e2e expectations),
  `SECURITY.md` (private reporting channel — the app holds Soulseek creds and
  JWTs), issue templates (bug/feature, Immich-style env+version fields), a PR
  template, `CODE_OF_CONDUCT.md`, `FUNDING.yml` if desired. (S)
- **Enable GitHub Discussions** — currently off. Immich runs support, Q&A,
  per-release threads, and a dedicated **breaking-changes board** there,
  keeping Issues for actual defects. (S)
- **Screenshots + demo** — the repo has zero images; a hero screenshot in the
  README is the single cheapest adoption lever. Immich goes further with a
  public demo instance (`demo@immich.app`/`demo`) — worth it once a
  seed-library + read-only role config exists (the `listener` role is most of
  it). (S for screenshots, M for demo)
- **Docs split: user vs developer** — HA separates user docs from developer
  docs entirely; Immich runs Docusaurus from `docs/` in-repo. NicotinD's
  `docs/` is engineering notes; end-user material (install, admin guide, FAQ,
  troubleshooting) should become a small static site (Docusaurus/Starlight)
  with `docs/` staying internal. (L)
- **Stability statement at 1.0** — Immich carried a "breaking changes,
  not your only backup" banner for years, then shipped a dedicated "what
  stable means" post at v2.0 (semver promise, upgrade friction bounds).
  NicotinD should do the same deliberately: state pre-1.0 expectations in the
  README now; publish the guarantees when tagging 1.0. (S)
- **Opt-in transparent analytics** — HA's model: strictly opt-in, the exact
  payload printed to the user's log on every send, aggregates published on a
  public dashboard that doubles as social proof. Philosophical choice —
  flagged as optional; if ever added, HA's transparency bar is the only
  acceptable design. (M, optional)

## Suggested order

1. Infra pins + analysis image + community health files + screenshots (cheap,
   immediate adoption wins).
2. Backup/restore, watchdog + health taxonomy, retention (robustness core).
3. Update check + version history + audit log (server management).
4. Docs site, SDK generation, hwaccel overlay, stability statement (the 1.0
   runway).
