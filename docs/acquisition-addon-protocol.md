# Acquisition Addon Protocol — slskd becomes an external, Torrentio-style addon

**Status**: Phase 0 (protocol v1 + core addon runtime, #487), Phase 1 (the in-monorepo
`packages/slskd-addon` with the moved hunt engine, #488) and the **phase-2 cutover spine**
(#489 — addon-backed provider, job-feed mirroring + HTTP ingest, unattended acquisition
via the protocol, opt-in compose service; see the phase-2 section for what remains) are
**shipped**, and so is phase 3 (core carries zero slskd code) and phase 4 (repo split): the addon
lives in `kevinch3/nicotind-slskd-addon` with its own CI + published GHCR image, `@nicotind/addon-sdk`
is on npm, and `packages/slskd-addon` + `packages/slskd-client` are gone from the monorepo (only the
deploy-host re-migration onto the published image remains). Each phase gets its own implementation plan + PR cycle;
this document is the architecture they all answer to.

## Context & goal

slskd today is "off by default" but not _absent_: the hunt/retry/fallback engine is typed
against the concrete `Slskd` client, 18 slskd wire interfaces live in `@nicotind/core` and
reach the Angular UI, the default compose stack includes the slskd container with a hard
`depends_on`, and `src/main.ts` constructs the client unconditionally. Distribution compliance
is already decent — nothing is vendored, the binary/image come from upstream at runtime, and
the plugin is default-off + consent-gated + validator-enforced — but the _architecture_
doesn't match that posture.

The goal is the **Stremio/Torrentio structure**: NicotinD defines an open HTTP "acquisition
addon" protocol; all slskd code eventually moves to a **separate repo + Docker image**
maintained apart from the product; core ships with zero slskd code. Sources become
user-added addons registered by URL, and the product is genuinely source-agnostic — the
existing north star ("adding a source = one adapter + a pure mapper") extended across a
process/repo boundary.

## Decisions (brainstormed 2026-08-11)

1. **Full Torrentio** — separate repo at the end state, open protocol, zero slskd code in core.
   Not the lighter alternatives (in-monorepo sidecar forever, or in-process severing only).
2. **Protocol covers both capability shapes** — network sources (search/browse/acquire-album,
   the slskd shape) and URL resolvers (yt-dlp/spotdl/archive) — but **only slskd migrates
   now**. The in-process plugins stay until someone chooses to migrate them; the DTOs are
   designed so that adapter is mechanical.
3. **Smart addon, thin core.** The hunt/retry/fallback engine moves _into_ the addon:
   `AlbumHunterService` (+ `scoreFolders`), `TrackHunterService`, `AlbumFallbackService`,
   `DownloadRetryService`, `hidden-transfers`, `slskd-status`, `slskd-config`,
   `hunt-queries.ts`, and the transfer-polling half of `DownloadWatcher`. Core keeps
   everything source-agnostic: the `acquisition_jobs` ledger + issue-#262 hygiene, the
   organize→scan pipeline, watchlist/auto-acquire orchestration, Lidarr/catalog, and the UI.
   Rationale: nearly all of that engine is Soulseek-shaped (skewed queries dodge slskd's
   search cache; fallback waves are peer semantics) — a yt-dlp addon needs none of it, and
   Torrentio itself proves ranking belongs addon-side.
4. **HTTP file delivery.** The addon downloads into its own private storage; core streams
   finished files from the addon over HTTP into its staging dir, then the existing
   organizer/scanner take over. No shared volume in the _protocol_. One deliberate bend:
   slskd _sharing out_ the music dir (Soulseek etiquette) still wants a read-only mount of
   the music dir on the addon container plus a `notify/library-changed` capability replacing
   `ShareRescanScheduler`'s direct `shares.rescan()` — that's deployment topology for one
   optional capability, not the delivery channel.
5. **Generic UI, no slskd Angular code survives.** The addon manifest declares config-field
   schema + status fields; NicotinD renders a generic addon card (form-from-schema, status
   pill, consent flow) by **reusing the existing plugin kernel / Extensions UI**. The Acquire
   page's raw "Advanced" folder-browser lane becomes an optional generic `browse` capability.
   The bespoke slskd shares/uploads views fold into generic status rows — an accepted
   fidelity loss.

## Verified seams (what exploration confirmed, so implementation doesn't re-derive it)

- **Watchlist/auto-acquire are orchestration only** — they use slskd solely by passing it to
  `acquireAlbum()`. They stay in core untouched apart from a dependency swap.
- **`acquireAlbum` straddles the seam.** Its idempotency guards (`albumAlreadyComplete`,
  in-flight check), `filesForCanonicalTracks`/`filesMissingOnDisk` scoping,
  `recordAcquiredArtistIdentity`, and `createJob` are library knowledge = core. Only
  "hunt, score, pick, enqueue, arm fallback" crosses to the addon. Core passes
  `canonicalTracks` + `wantedTracks` (missing-on-disk subset); the addon scores against the
  full canonical list but acquires only wanted tracks — a 1:1 mapping onto the existing
  #262 scoping.
- **The hunt engine never touches Lidarr or the library DB** — canonical tracks arrive as
  input. The addon needs zero catalog access.
- **The Downloads feed already reads `acquisition_jobs`/`acquisition_job_items`**, not raw
  slskd transfers. The feed survives the migration by mirror-upserting addon job items;
  only the raw transfers lane in `routes/downloads.ts` dies.
- **`hunt-queries.ts`'s web consumer** is only the hunt modal's query-string display; the
  protocol's `queries[]` debug field replaces it, and the module moves wholesale to the addon.
- **`album_jobs` + `hidden_transfers` move to the addon's own SQLite.** Safe: every
  addon-era enqueue creates a unified `acquisition_jobs` row, so the `album_jobs` half of
  the UNION readers becomes vestigial in core.
- **e2e never exercised the network lane** (dead slskd in config). The fixture addon server
  makes real acquisition e2e possible for the first time — a coverage win, not just cost.

## Protocol v1 (Phase 0 expands this section into the full endpoint reference)

- **Auth**: static bearer token exchanged at registration; everything requires it except
  `manifest` and `health`. The addon serves music bytes and initiates downloads — the
  analysis-sidecar "unauthenticated on LAN" posture is not enough here.
- **Versioning**: manifest carries `protocolVersion` (semver); core declares a supported
  range and refuses registration outside it; v1 evolves additively only. Source-specific
  fields (e.g. `queuePosition`) stay optional/namespaced so slskd-isms don't calcify into
  the "generic" DTOs.
- **Progress transport: polling** (`GET jobs?since=`), on the adaptive cadence
  `DownloadWatcher` uses today. SSE/webhooks are a compatible later optimization.

Endpoints under `/addon/v1/`:

| Endpoint                                            | Purpose                                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET manifest` (unauth)                             | id, name, version, `protocolVersion`, capabilities, `configFields` (same descriptor shape as plugin configFields), `statusFields`, `compliance{disclaimer, requiresConsent}`, `urlPatterns?`                                                                                       |
| `GET health` (unauth)                               | `{ok, ready, detail}` — the analysis-sidecar precedent                                                                                                                                                                                                                             |
| `GET status`                                        | typed key/value stat rows → the generic status panel                                                                                                                                                                                                                               |
| `PUT config`                                        | core remains source of truth (creds/shares/limits survive addon container recreation); addon persists a copy                                                                                                                                                                       |
| `POST search`                                       | sync with a `waitMs` budget → `AcquisitionCandidate`-shaped results; an addon-backed provider registers into the existing `ProviderRegistry`, so blended search and ranking are unchanged                                                                                          |
| `POST albums/search`                                | `{artist, album, canonicalTracks[]}` → scored folder candidates (`candidateRef` opaque token, username, folder, matchPct, files with size/bitrate/format) + `queries[]` debug field                                                                                                |
| `POST jobs` (+ `Idempotency-Key`)                   | `{intent: album\|tracks\|browse-grab\|url, albumKey, canonicalTracks?, wantedTracks?, candidateRef?, minMatchPct?, url?}` → `201 {job}` or `409 {existingJobId}`. Idempotency is two-layer: core's guards run first (as today); the addon 409s duplicate active jobs on `albumKey` |
| `GET jobs?since=` / `GET jobs/:id`                  | items carry a **stable `itemId`** — the repoint contract: addon-internal fallback re-pulls flip `username` on the _same_ item, and core's mirror upsert reproduces `repointItem` semantics without knowing fallback exists                                                         |
| `POST jobs/:id/cancel` / `retry`, `DELETE jobs/:id` | job actions the Downloads UI fans out                                                                                                                                                                                                                                              |
| `GET jobs/:id/files/:itemId`                        | file bytes once `fileReady` (Content-Length + ETag); core streams into staging, deletes the job after full ingest; a 7-day addon janitor mops up                                                                                                                                   |
| Optional capabilities                               | `browse` (`GET browse?user=&path=` — Advanced lane), `sharesLibrary` (`POST notify/library-changed`), `feedback` (`POST jobs/:id/feedback` — hunt-match 👍/👎 keeps feeding the addon's replay fixtures)                                                                           |

**Feed continuity**: each poll upserts items into `acquisition_job_items` keyed
`addon:<addonId>:<itemId>` — `transfer_key` relaxes from `username::filename` to an opaque
key (precedent: `acquire_jobs.backend` relaxing to an open plugin id). `DownloadItem`,
the sources[] disclosure, Now:/Next:, and the bitrate chip read the same tables as today.
URL resolvers fit as `intent: 'url'` + manifest `urlPatterns` (mirrors `getEnabledForUrl`).

### Phase-0 implemented surface (shipped)

The four manage/observe endpoints are live, exactly as sketched above:

- `GET /addon/v1/manifest` (unauth) → the `AddonManifest` DTO (`@nicotind/core`
  `types/addon.ts`, zod-parsed by `addonManifestSchema`, coherence-checked by
  `validateAddonManifest` — same id/kind/capability rules as builtin plugins plus the
  `addonProtocolSupported` same-major check against `ADDON_PROTOCOL_VERSION` 1.0.0).
- `GET /addon/v1/health` (unauth) → `{ok, ready, detail?}`; drives `isAvailable()` and the
  card's status pill.
- `GET /addon/v1/status` (bearer) → `AddonStatusRow[]` (`{key, label, value}`), rendered by
  the generic `AddonStatusPanelComponent` — no addon-specific UI.
- `PUT /addon/v1/config` (bearer) → core pushes the admin-saved config down on every plugin
  (re-)init; a down addon logs a warning and never fails enable/boot.

Core-side pieces: `AddonClient` (`services/addons/client.ts`, injected `fetchFn`, 10 s
timeout, typed `AddonRequestError`), `RemoteAddonPlugin` (`remote-addon-plugin.ts`, adapts
the manifest via `pluginManifestFromAddon` with `defaultEnabled:false`), the
`addon_registrations` table + `services/addons/store.ts` (the outbound bearer is stored
**plaintext by necessity** — it must be replayed on every call; same credential class as the
Soulseek creds), and `services/addons/manager.ts` (`loadRegisteredAddons` at boot from the
manifest snapshot — no network, a down addon still renders its card;
`registerAddon`/`removeAddon`). Admin routes on `/api/plugins`: `POST /addons` (register by
`{url, token}`, audit-logged `addon.register`, 502 on unreachable / 400 on invalid),
`DELETE /addons/:id` (`addon.remove`), `GET /:id/addon-status` (degrades to
`{available:false}` rather than 500). The web Extensions page gains an "Add addon" form in
the Acquisition group and a per-card Remove for `remote` cards; `PluginInfo` carries
`remote`/`addonUrl`. e2e: `tests/helpers/fixture-addon.ts` + `addon-registry.spec.ts` cover
register → consent-gated enable → status panel → remove against a live in-process addon.

## Phasing — in-monorepo addon first, repo split last

Each phase keeps master shippable and is its own spec→plan→PR cycle with a GH tracking
issue. Rationale for monorepo-first: `bun run verify` + CI parity cover the addon through
the whole migration; protocol churn is a same-PR change, not a two-repo lockstep; embedded/
desktop mode can spawn the addon via `bun run` during transition; the kpc deployment
validates the topology before the split; `git subtree split` preserves history at the end.

### Phase 0 — Protocol + core addon runtime (small visible feature)

The full protocol reference (this doc, expanded); `packages/core/src/types/addon.ts`; `packages/api/src/services/
addons/{client,remote-addon-plugin}.ts` (+tests). `RemoteAddonPlugin` wraps the addon HTTP
client in the existing `Plugin` interface, so the entire Extensions UI (cards, consent,
capability gating, status pill) is reused. Admin gains "Add addon" (URL + token → fetch
manifest → card). e2e fixture addon server + `addon-registry.spec.ts`. Modify: plugin
manifest validation (remote-sourced manifests), `services/plugins/registry.ts`,
`routes/plugins.ts`, web plugins page.

### Phase 1 — Build the slskd addon in-monorepo (no cutover) — SHIPPED (#488)

As designed, with three measured amendments:

- **`hunt-queries.ts` stays in `@nicotind/core`** (not moved as originally sketched): the
  addon depends on core anyway, and the web keeps its own shim copy — moving it would
  have broken `packages/web/src/types/core.ts` for nothing.
- **`normalizeTitle`/`titlesOverlap` were promoted to core first**
  (`packages/core/src/title-match.ts`): eight non-slskd api files (library-organizer,
  library-completeness, library-track-select, acquisition-job-store, catalog-search,
  repair-album-folders…) imported them through the hunter; without the promotion the
  extraction would have dragged the library layer along.
- **slskd supervision did not move yet** — `service-manager`/`download-deps.ts` stay
  untouched until phases 3/4; the addon reaches slskd via config/env.

What shipped: `packages/slskd-addon` — own SQLite (`album_jobs`/`transfer_retries`/
`hidden_transfers`/`completed_downloads` copies + the `addon_jobs`/`addon_job_items`
protocol ledger + pushed-config kv), the moved hunt engine (album-hunter with
`CanonicalTrackRef` replacing `LidarrTrack` — the addon never sees Lidarr; track-hunter +
track-pick; slskd-status/-config; hidden-transfers; the replay corpus +
`album-hunter.replay.test.ts`), `AlbumFallbackService` behind the new **`FallbackHost`**
seam (api implements it over acquisition-job-store + the library in
`services/fallback-host.ts`; the addon over its own job ledger in
`addon-fallback-host.ts`), the **`TransferPoller`** (the polling half of
DownloadWatcher; the api watcher now composes it), and the full protocol engine surface:
`POST search`, `POST albums/search` (candidateRef TTL cache + literal `queries[]`),
`POST jobs` (album/tracks/browse-grab, Idempotency-Key + per-album 409, wanted-track
scoping), `GET jobs` (+ live transfer-state sync), cancel/delete,
`GET jobs/:id/files/:itemId` (Content-Length + ETag), `GET browse`,
`POST notify/library-changed` (debounced share rescan). Dockerfile with a
health-checked `oven/bun` image.

**During phases 1–2 the api imports the moved services from
`@nicotind/slskd-addon`** through path-preserving shims (e.g.
`packages/api/src/services/album-hunter.service.ts` is a named re-export) — one source
of truth, in-process path unchanged, severed in phase 3.

**Accepted limitation (revived jobs, addon mode)**: the addon's `FallbackHost.onDiskTitles`
returns `[]` — it has no library. The host pre-filters via `wantedTracks` at job creation,
so a *revived* exhausted job in addon mode may re-pull tracks that landed since; the
organizer dedupe + 24h valve bound the damage. The api-hosted fallback (still what ships)
keeps the live library read.

### Phase 2 — Core cutover (the user-visible phase) — SPINE SHIPPED (#489)

**Shipped:** the additive cutover spine. With a remote addon registered + enabled, core
speaks the protocol; without one, the in-process path is untouched (its deletion is
phase 3).

- `AddonClient` engine surface (search/albums-search/jobs/file-fetch/browse/notify,
  per-call timeouts); `AddonSearchResult` carries peer health so ranking inputs survive
  the hop.
- `AddonSearchProvider` (services/addons/search-provider.ts) adapts the addon's sync
  search onto the kernel's poll shape; `RemoteAddonPlugin` declares
  search/browse/download capability accessors and (de)registers the provider in
  `ProviderRegistry` on init/dispose — blended search, the raw network lane, browse and
  the enqueue route light up with **zero route changes** (the SlskdPlugin contract).
- `AddonJobPoller` (services/addons/job-poller.ts): mirrors addon jobs/items into
  `acquisition_jobs`/`acquisition_job_items` keyed `addon:<id>:<itemId>` (a fallback
  repoint is an in-place upsert), fetches fileReady completions into
  `<dataDir>/addon-incoming`, runs them through the same organize→scan pipeline, records
  provenance under the addon id (`AcquisitionMethod` opened to any string), and releases
  fully-ingested terminal jobs addon-side. Gated on the #235 kill-switch; cursor + job
  mapping in `plugin_kv`.
- `acquireAlbum` addon path: hunt/pick/wanted-scope/fallback run addon-side; every
  library guard (albumAlreadyComplete, on-disk wanted filtering via the now-exported
  `onDiskTitles`, artist identity, the feed row + hunt metadata) stays core-side; the
  addon's per-album 409 is the in-flight guard. Watchlist + auto-acquire pass the live
  `getAddon` lookup.
- e2e: the fixture addon grew the engine surface and `addon-acquire.spec.ts` proves the
  loop — job → feed mirror → HTTP fetch → organize (Opus standardization included) →
  scan → provenance → the feed's deep-linkable albumId. First CI coverage of a real
  acquisition ingest.
- Compose: opt-in `slskd-addon` service (`--profile slskd-addon`, builds from source
  until the phase-4 image publish); in this topology the addon serves files from
  slskd's landing dir, and the soak instructions say to disable the in-process slskd
  plugin so both halves never process the same completions.

**#489 remainder — SHIPPED with phase 3:** interactive hunts run through
`albumsSearch`/`candidateRef` (hunt-download acquires the user's exact pick;
replace-flow cancels the addon's active job); the downloads feed's job actions
(`cancel`/`delete`) route addon-keyed items to the addon client. The **kpc side-by-side
soak** — the ship gate for merging the chain — remains the operator's step.

### Phase 3 — Delete slskd from core — SHIPPED (#490, BREAKING)

Core now carries **zero** slskd code; a NicotinD without a registered addon is a
streaming/library install with URL-resolver acquisition only.

- Deleted from core: the in-process `SlskdPlugin` + provider + its watcher half, the
  hunt/retry/fallback wiring, `SlskdRef` threads, `core/src/types/slskd.ts`,
  `@nicotind/slskd-client` from `@nicotind/api`'s graph, ServiceManager's slskd
  strategy + the deps-downloader entry, the `soulseek`/`slskd` config sections, and the
  raw `transfers.*` lane in `routes/downloads.ts`.
- Route surface: settings lost `/soulseek*` + `/shares*`; setup lost the Soulseek wizard
  step; `system` lost the slskd status slice, the restart route and the slskd log
  stream; `review` lost `services.slskd`; the mcp/library share-rescan hook became the
  protocol's `notify/library-changed`.
- Suppression: downloading-album suppression keys on the unified `acquisition_jobs`
  ledger alone (`getDownloadingGroupKeys(db)`); the raw-transfer key set is gone.
- Web: `SlskdSettingsComponent`, the admin services card, the wizard step and the raw
  transfer feed deleted; `TransferService` polls the jobs feed only; finished jobs
  surface as history cards with cancel/remove mapped to the job actions.
- Compose: the base file is streaming + Lidarr; `slskd` + `slskd-addon` sit behind the
  `slskd-addon` profile (`--profile slskd-addon`), so a default deploy runs neither. The
  planned separate `docker-compose.acquisition.yml` overlay collapsed into that profile —
  one file, same semantics. `docker-compose.streaming-only.yml` keeps only the
  Lidarr/bgutil half of its job.
- The slskd wire types left `@nicotind/core` for `@nicotind/slskd-client` (their
  natural home; the client + addon are the only consumers). Core's
  generation-feedback snapshot types now use a structural `CapturedSearchResponse`
  instead of the slskd wire type. Web's raw-transfer feed machinery
  (`groupByAlbum`, the collapse helpers, the `DownloadKind` `'slskd'` value — now
  `'network'`) is deleted; `mergeAcquisitionJobs` renders job rows only.
- Acceptance: `grep -ri slskd` over core packages returns docs/history, test
  doubles, and data values (the addon's manifest id used as method/provenance)
  only.

**Accepted (documented) losses**: hunt feedback capture is dormant until the protocol
grows a `feedback` capability; addon-mode revived jobs lose the live on-disk wanted
filter (see the phase-1 limitation above).

### Phase 4 — Repo split (published SDK + own image)

Sequenced as reversible in-repo engineering first, outward/irreversible steps last:

**4a — extract `@nicotind/addon-sdk` (SHIPPED, in-monorepo).** The addon-facing subset of
core is now its own leaf package (`packages/addon-sdk`, deps = `zod` + `pino` only), so an
addon — first-party or third-party — builds against a stable, publishable surface instead
of all of core. It **owns** the protocol contract + shared hunt helpers: `manifest.ts`
(the plugin-manifest an addon declares), `addon.ts` (v1 DTOs/schemas/`negotiateCapabilities`),
`addon-capability-risk.ts`, `addon-protocol-schema.ts`, `hunt-queries.ts`, `title-match.ts`,
and its own leaf `logger.ts`. `@nicotind/core` keeps thin re-export **shims** at each old
path (`export * from '@nicotind/addon-sdk/<module>'` via the SDK's subpath `exports` map), so
every in-monorepo `from '@nicotind/core'` import site resolves unchanged and no barrel entry
moved — the dependency is one-directional (core → addon-sdk; the SDK never imports core, so
no cycle). `packages/slskd-addon` now depends on **only** `@nicotind/addon-sdk`; the one edge
type it took from core outside the SDK surface — `HuntMatchFixture`, used solely by the
replay test — was made a local addon type (`services/hunt-match-fixture.ts`), since the
golden-dataset shape is a serialization contract the split-out addon must own standalone.
`packages/addon-sdk/src` was added to the CI test-package list (the moved `bun:test` files
would otherwise silently stop running — the Gate 2 drift class).

**4b — decouple `slskd-client` from core (SHIPPED, in-monorepo).** `slskd-client` now imports
`createLogger`/`Logger` from `@nicotind/addon-sdk` and defines `BrowseDirectory`/`NetworkFile`
as local slskd wire types (in its own `types.ts`; core keeps structurally-identical copies for
its generic browse lane, so TS structural typing keeps consumers assignable). Both packages that
leave in the split — `slskd-client` and `slskd-addon` — are now **core-free**, depending only on
`@nicotind/addon-sdk`. The remaining split prep (the SDK's npm publish hardening —
build + `files`/`exports` for a compiled artifact — the external-repo CI workflow and Dockerfile)
is folded into the 4c handoff, since it is tied to the actual publish and needs dual src/dist
`exports` care to not break in-monorepo resolution.

**4c — cut over (SHIPPED, outward).** The external repo `kevinch3/nicotind-slskd-addon` (public)
was assembled via `git subtree split` (each package keeps its history) as a self-contained Bun
workspace: `slskd-addon` + `slskd-client` + a transitionally-vendored `addon-sdk`, with its own CI
that builds and publishes `ghcr.io/kevinch3/nicotind-slskd-addon` on `main`/tags. `@nicotind/addon-sdk`
is published to **npm** (`@nicotind/addon-sdk@0.1.0`). Core's compose `slskd-addon` service now
references the **published image** (not a source build), and `packages/slskd-addon` +
`packages/slskd-client` are **deleted from the monorepo** — core keeps only the npm-published
`addon-sdk`. Remaining: on the deploy host, make the GHCR package pullable and re-migrate the
running addon onto the published image + soak (a host/prod step). The npm publish of
`@nicotind/slskd-client` (so the external repo can drop its vendored SDK/client copies) is optional
— the external repo works standalone as-is.

## Risks (ranked)

1. **Embedded/desktop mode distribution** — mitigated by monorepo-first (spawn via
   `bun run`), resolved by the Phase 4 compiled binary. If the binary slips, desktop
   temporarily loses Soulseek; streaming is unaffected.
2. **Item identity/repoint across the boundary** — a fallback repoint duplicating instead
   of updating items corrupts the "9 of 13" tallies. The stable-`itemId` contract must be
   tested against the replay/fallback suites before cutover.
3. **kpc migration** — Soulseek creds move core → addon config push; in-flight jobs at
   cutover fail honestly via the existing 24h valve; dead core tables (`album_jobs`,
   `hidden_transfers`) are left in place and dropped in a later migration.
4. **Protocol slskd-ism leakage** — source-specific fields stay optional/namespaced.
5. **Library sharing** — the read-only mount + `notify/library-changed` must be on the
   Phase 2 checklist, or the "File not shared" spam `ShareRescanScheduler` fixed returns.
6. **Auth posture** — a static bearer on a LAN is acceptable for compose networks but the
   docs must say so explicitly; off-box deployments should front the addon with TLS.

## Verification

- Every phase: `bun run verify` + `bun run e2e` (quality gates 1–2); the fixture-addon e2e
  specs are standing coverage from Phase 0 on.
- Phase 1: the moved hunt suite green inside the addon package, including the replay
  fixtures.
- Phase 2: kpc side-by-side soak — real Soulseek hunt through the addon; verify feed
  cards, repoint behavior, ingest, share-rescan notify; Downloads feed parity screenshots.
- Phase 3: the grep acceptance check; streaming-only base compose boots with no slskd or
  addon anywhere.

## Resolve addons (sub-project C — the `url` seam + bundled addons)

The reserved `url` job intent is now implemented, so URL resolvers (yt-dlp/spotdl/archive) become
addons too. **First spec shipped**: the `url`/`resolve` protocol seam + **archive.org migrated to a
bundled built-in addon**.

- **`AddonTransport` interface**: extracted from the concrete HTTP `AddonClient`. Two impls —
  `HttpAddonTransport` (external addons) and `LocalAddonTransport` (bundled first-party addons,
  direct in-process calls; `fetchFile` wraps `Bun.file(path)`, no HTTP/byte-copy). `RemoteAddonPlugin`,
  the poller, the search provider and the manager depend on the interface, so a bundled addon flows
  through the identical lanes.
- **Bundled archive addon** (`services/addons/bundled/archive/`): the resolve engine (`engine.ts`) +
  a `BundledAddon` job model whose `createJob` returns immediately and resolves in the background.
  Boot-registered by `registerBundledAddons` through the same `registerAddon` path (id
  `bundled-archive`, non-removable via the `origin.bundled` flag — a `local:` transport target —,
  disabled until the admin enables the consent-gated card; no `addon_registrations` row). `resolve`
  was added to `CORE_IMPLEMENTED_ADDON_CAPABILITIES`.
- **Protocol additions**: `AddonJobIntent += 'url'`; `AddonJobRequest.url?` + `as?`; the tagless
  `ResolveResult.meta` rides the existing `AddonJob.artist/album` fields. `KIND_BY_INTENT` maps
  `url → 'url'`; the poller backfills the feed row's artist/album once the background resolve supplies
  them (else tagless archive files land `unsorted`).
- **Routing + feed**: `POST /api/acquire` prefers `resolveAddonForUrl` (urlPattern match) and eagerly
  mirrors a `kind:url` row (in-flight card at submit — #509 cause 2), falling back to in-process
  resolve plugins. The web `mergeAcquisitionJobs` no longer blanket-skips `kind:url` — it skips only a
  url job already rendered by the in-process `acquire_jobs` lane, so an addon url job renders through
  the unified lane (#509 cause 1). The in-process archive plugin was retired.
- **yt-dlp external addon (C2 — SHIPPED)**: yt-dlp left core entirely for
  `kevinch3/nicotind-ytdlp-addon` (own repo + published GHCR image), consuming the published
  `@nicotind/addon-sdk`. It declares an optional `AddonManifest.priority` (default 0) and the
  catch-all `urlPatterns: ['^https?://']` at `priority: -10`, so specific addons (archive, a future
  spotdl) win their URLs and yt-dlp takes everything else. Core added `priority` to the manifest +
  schema (A1) and made `resolveAddonForUrl` collect all pattern matches and pick the
  highest-priority (A2). The in-process `YtdlpPlugin` + its `config.acquire.ytdlp` block + the
  `legacy-seed` yt-dlp path were removed (A3); `docker-compose.yml` gained an opt-in `ytdlp-addon`
  profile (the addon + a dedicated `ytdlp-pot-provider` companion sharing its netns for the bgutil
  PO-token flow; the core-side `bgutil-provider` served in-process spotdl until #550 removed both).
  Registered like the
  slskd addon (Extensions → Add addon, `http://ytdlp-addon:8586`). The addon carries a documented
  `intent: 'url' as unknown as …` cast until `@nicotind/addon-sdk@^0.1.1` (with the `url` intent)
  publishes.
- **spotdl external addon (C3 — SHIPPED)**: spotdl left core for `kevinch3/nicotind-spotdl-addon`
  (own repo + published GHCR image), built by mirroring the C2 ytdlp-addon scaffold. It declares
  `urlPatterns: ['spotify\\.com']` at the **default** priority (0), so it beats the yt-dlp catch-all
  (`priority: -10`) for Spotify URLs. Optional Spotify creds are the addon's **own** env
  (`SPOTDL_ADDON_CLIENT_ID`/`SECRET` → `SPOTIPY_*` on spawn) — it does **not** reach into core's
  spotify plugin (that coupling — the removed `SpotdlPlugin`'s `readSpotifyCredentials`/`spotifyEnvFor`
  — is gone). Dockerfile = spotdl + Deno (its embedded yt-dlp needs a JS runtime; also `unzip` for the
  Deno installer) + the bgutil pot-provider plugin. The in-process `SpotdlPlugin` + `config.acquire.spotdl`
  were removed, and with spotdl the last in-process acquisition plugin the whole `legacy-seed`
  migration was retired. `docker-compose.yml` gained an opt-in `spotdl-addon` profile (addon +
  dedicated `spotdl-pot-provider` companion). Same documented `intent: 'url' as unknown as …` cast
  pending addon-sdk 0.1.1. **With C1/C2/C3 shipped, every URL/network acquisition source is now an
  addon — core carries zero source code.**
- **Orphaned-job reconcile (issue #515)**: the yt-dlp/spotdl addons keep jobs **in-memory**, so an
  addon restart mid-download drops them — and core's cursor-based poll only *updates* jobs the addon
  still lists, so a dropped job sat "downloading" until the 24h valve (real prod symptom right after
  the v0.3.5 cutover deploy: ghost cards + a raw `addon:<id>:<uuid>` title + an "Unknown source"
  chip). `AddonJobPoller.reconcileOrphanedJobs` now re-checks stale (`>ORPHAN_STALE_MS`, 5 min) active
  addon jobs via `getJob` and **fails the ones the addon 404s** (a slow-but-live job the addon still
  returns is left alone). Web-side, `methodForBackend` maps the `-addon`/`bundled-archive` ids to the
  base method (fixes the chip) and the feed shows a friendly `"<Source> download"` label instead of
  the opaque `addon:` key until metadata resolves. **Root cause now fixed at the source (issue #515):**
  the yt-dlp/spotdl addons persist their job store to SQLite (`<dataDir>/jobs.db`) and, on boot, mark
  any still-`active` job **failed** — so a restart reports an honest failure the addon itself owns,
  and `reconcileOrphanedJobs` is now the backstop rather than the only defense (slskd was always
  immune — it persisted from day one). The "retryable failed URL cards" half of #515 was **not built**:
  `acquisition_jobs` has no `url` column and the addon `source_ref` is the opaque `addon:<id>:<jobId>`
  key, so a Retry would need url-persistence plumbing for marginal benefit over re-pasting the URL
  (which already re-submits idempotently).
- **Follow-ups**: retiring `acquire_jobs`/`AcquireWatcher` (the last in-process resolve lane is gone,
  so the URL path can move fully onto the `AddonJobPoller` feed); publishing `@nicotind/addon-sdk@0.1.1`
  with the `url` intent to drop the cast in all three external addons.

## Out of scope

- Migrating yt-dlp/spotdl/spotify onto the protocol as *external* addons (C2/C3 — the DTOs allow it).
- SSE/webhook progress transport (polling first).
- Addon marketplace/discovery UX — v1 is "paste a URL + token".
