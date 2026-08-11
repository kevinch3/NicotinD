# Acquisition Addon Protocol — slskd becomes an external, Torrentio-style addon

**Status**: Phase 0 (protocol v1 + core addon runtime, #487), Phase 1 (the in-monorepo
`packages/slskd-addon` with the moved hunt engine, #488) and the **phase-2 cutover spine**
(#489 — addon-backed provider, job-feed mirroring + HTTP ingest, unattended acquisition
via the protocol, opt-in compose service; see the phase-2 section for what remains) are
**shipped**; phases 3–4 pending. Each phase gets its own implementation plan + PR cycle;
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

**Remaining in #489 (deferred, before phase 3 can start):** the interactive discography
hunt routes still call the in-process hunter (`albums/search` + `candidateRef` exist for
them); `routes/downloads.ts`'s raw `transfers.*` actions don't yet proxy addon-keyed
items; the bespoke slskd web surfaces stay until phase 3; and the **kpc side-by-side
soak** — the ship gate — is the operator's step.

### Phase 3 — Delete slskd from core

Remove `packages/slskd-client` from core's dependency graph, `core/src/types/slskd.ts`,
every `SlskdRef` thread, ServiceManager slskd files, web slskd type remnants. Compose:
streaming-only semantics become the **base** file; `docker-compose.acquisition.yml` overlay
adds the addon. Acceptance: `grep -ri slskd` over core packages returns only docs/history.

### Phase 4 — Repo split (mechanical)

`git subtree split` of `packages/slskd-addon` (with `slskd-client` folded inside) → new
repo, own CI, published Docker image + bun-compiled binary (what embedded/desktop mode
downloads instead of the slskd zip). Core compose references the published image; the
package is deleted from the monorepo.

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

## Out of scope

- Migrating yt-dlp/spotdl/archive/spotify onto the protocol (the DTOs allow it later).
- SSE/webhook progress transport (polling first).
- Addon marketplace/discovery UX — v1 is "paste a URL + token".
