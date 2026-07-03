# Native auto-acquisition loop (Soularr-equivalent, NicotinD-internal)

Status: **implemented** (opt-in, default-off). This document records the original decision
and design; the "As-built" note at the end records where the shipped code diverged from the
plan below (it landed smaller than first sketched).

## Context

[Soularr](https://github.com/mrusse/soularr) is a standalone script that polls Lidarr's
*missing/wanted* list, searches slskd for each album, downloads the best match, and hands
the files back to Lidarr to import. We evaluated adding it between our Lidarr and slskd and
**rejected running it as-is**.

NicotinD has already re-implemented Soularr's hard part — and more capably:

- `AlbumHunterService` (`packages/api/src/services/album-hunter.service.ts`) — scored slskd
  matching, diacritic-insensitive titles, skew-search soft-ban bypass.
- `AlbumFallbackService` — per-track cross-peer recovery.
- `DiscographyService` / `lidarr-provision.ts` — add-artist-on-demand.
- `LibraryOrganizer` — canonical-folder placement + dedupe.

Crucially, NicotinD uses Lidarr **only as a metadata source** (`add(... searchForMissingAlbums:
false)`); file placement is owned by `LibraryOrganizer`, not Lidarr. Running Soularr would
create a **second acquisition pipeline** competing over the same slskd instance and music dir,
and would want Lidarr to own imports — reintroducing exactly the duplicate-download /
dual-brain problem the idempotent-hunt work eliminated.

The **only capability Soularr has that NicotinD lacks** is the *autonomous* part: monitor a
wishlist and acquire/retry in the background instead of clicking hunt per album. The right
design is a thin internal scheduler that polls Lidarr's missing list and feeds the **existing
idempotent hunt flow** — reusing the whole engine and relying on the `409 already-downloading`
/ `already-complete` guards in `discography.ts` (`hunt-download`) to stay safe and re-entrant.
No new matching/download/organizing code.

## Design

### 1. Extend `lidarr-client` with the missing-list endpoint

`packages/lidarr-client/src/api/album.ts` (+ `types.ts`): add `wantedMissing(page, pageSize)`
→ `GET /api/v1/wanted/missing?sortKey=...&monitored=true`, returning monitored albums Lidarr
doesn't have. No `command`/import endpoint is needed — NicotinD organizes files itself; Lidarr
stays metadata-only.

### 2. `AutoAcquireService` — modeled 1:1 on `DownloadRetryService`

New `packages/api/src/services/auto-acquire.service.ts`, mirroring the existing interval-service
shape (`download-retry.service.ts`: `start()`/`stop()`, `private timer`,
`setInterval(() => void this.sweep(), intervalMs)`, injectable seams for tests). Each `sweep()`:

- Pulls Lidarr `wantedMissing`, capped at `maxPerSweep` (e.g. 3) so we never flood slskd.
- For each missing album, **skips** if an `album_jobs` row for that `lidarr_album_id` is already
  `active`, or the library is already complete — reuse the existing `albumAlreadyComplete` check
  (extract it from `discography.ts` into a shared helper both call).
- Calls `hunter.hunt(artist, title, tracks, { skewSearch: true })`, **auto-selects** the top
  candidate that clears a completeness threshold (`matchPct >= SKEW_TRIGGER_PCT`, the same bar
  the hunt service uses), then runs the **same enqueue + `recordJob`** body as `hunt-download`.
  Factor that body out of the route into a shared `enqueueHuntDownload(...)` so the route and the
  loop share one code path (and one set of idempotency guards).
- Albums with no confident candidate are left for the next sweep (bounded by the cap; no per-album
  infinite retry beyond what the fallback already does).

### 3. Wiring + config

- `packages/api/src/index.ts`: construct/`start()` an `AutoAcquireService` behind a flag, next to
  the existing `retryRef`/`fallback` wiring (it already has `lidarr`, `hunterSvc`, `slskdRef`, `db`).
- Config: add `downloads.autoAcquireEnabled` (default **false** — opt-in) and
  `downloads.autoAcquireIntervalMs` / `maxPerSweep` to `config/default.yml`, `.env.example`, and the
  config schema, mirroring `autoRetryEnabled`.

### 4. Admin surface (optional follow-up)

A read-only "Auto-acquire" status panel + toggle in the admin page, reusing the existing
`/api/discography/jobs` view for what the loop has queued. Can ship after the engine.

## Critical files

- `packages/lidarr-client/src/api/album.ts`, `src/types.ts` — `wantedMissing` endpoint
- `packages/api/src/services/auto-acquire.service.ts` — **new**, patterned on
  `packages/api/src/services/download-retry.service.ts`
- `packages/api/src/routes/discography.ts` — extract `enqueueHuntDownload` + `albumAlreadyComplete`
  into a shared module the loop reuses
- `packages/api/src/services/album-hunter.service.ts` — reuse `hunt()` + the `SKEW_TRIGGER_PCT`
  completeness bar for auto-selection
- `packages/api/src/index.ts` — construct + `start()` behind the config flag
- `config/default.yml`, `.env.example`, config schema — `autoAcquire*` options

## Tests (for the eventual implementation)

- `auto-acquire.service.test.ts`: a sweep enqueues a confident missing album once; skips albums
  with an active job / already complete; respects `maxPerSweep`; an injected `hunt` returning no
  confident candidate enqueues nothing. (Mirrors `download-retry.service.test.ts`'s injectable-seam
  style; runs under the existing `bun test packages/api/src` CI job.)
- `lidarr-client` `wantedMissing` request-shape test.

## As-built (what actually shipped)

The plan above predated two things that collapsed most of its proposed work, so the shipped
version is smaller and reuses more:

- **No extraction from `discography.ts` was needed.** By the time this was built,
  `WatchlistService.tryAcquire` already implemented the *entire* per-album acquire core the plan
  wanted (resolve → `albumAlreadyComplete` → active-`album_jobs` guard →
  `hunter.hunt(…, {skewSearch:true})` → auto-select top candidate `>= minMatchPct` →
  `filesMissingOnDisk` → enqueue → `AlbumFallbackService.recordJob`), and `albumAlreadyComplete`
  was already shared in `services/library-completeness.ts`.
- **Shared core lives in `services/album-acquire.ts`** (`acquireAlbum(deps, input)` → an
  `AcquireOutcome` enum). It was extracted out of `WatchlistService.tryAcquire`, which now calls
  it and maps the outcome to its row state (`enqueued|already-complete|in-flight` → acquired;
  `enqueue-failed` → failed; `no-candidate|slskd-unavailable` → touch/retry). The watchlist tests
  stayed green, proving the extraction was behavior-preserving.
- **`AutoAcquireService`** (`services/auto-acquire.service.ts`) is therefore just the interval
  poller: each sweep pulls `lidarr.album.wantedMissing(1, maxPerSweep)` and feeds each record to
  `acquireAlbum`. No new dedupe table — the `already-complete`/`in-flight` outcomes make repeated
  sweeps idempotent. The optional admin status panel (§4 above) was **not** built; the existing
  `/api/discography/jobs` view already surfaces what the loop queued.
- **Config** landed under `downloads.autoAcquire{Enabled,IntervalMs,MaxPerSweep}` (default off),
  env `NICOTIND_AUTO_ACQUIRE_ENABLED`; `minMatchPct` reuses `watchlist.minMatchPct`.
- **Tests:** `album-acquire.test.ts` (every outcome), `auto-acquire.service.test.ts` (sweep
  enqueues once, respects `maxPerSweep`, gated on acquisition, skips artistless records),
  `lidarr-client/src/api/album.test.ts` (request shape). All under existing CI globs.
