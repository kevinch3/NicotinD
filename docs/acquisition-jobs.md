# Unified acquisition jobs

Every download — slskd album hunt, cross-peer fallback recovery, raw
folder-browser grab, per-track search, URL acquire — is wrapped in one
**acquisition job** whose transfer↔job linkage is **stored at enqueue time**.
This replaces the old read-time `(username, directory)` string matching that
was re-derived independently in three places (`enrichWithAlbumJobs`, the
organizer's `jobLookup`, `transfer-group-keys`) and silently lost per-track
fallbacks, alternate-peer pulls and direct grabs.

## Why

- An album hunt used to show up in Active Downloads as raw slskd transfers
  whose link to the originating search was *guessed* by folder-string matching.
  Fallback tracks re-pulled from a different peer never matched; direct grabs
  had no job at all; a path discrepancy silently dropped the label.
- The hunt's Lidarr metadata (genres, year, MBIDs, canonical tracklist) died at
  enqueue instead of travelling to the organizer/scanner/enrichment, so the
  processing pipeline re-derived what the hunt already knew.

## Data model (`packages/api/src/db.ts`)

Two tables, written by `packages/api/src/services/acquisition-job-store.ts`
(plain function module, explicit `Database` parameter — same convention as
`acquisition-store.ts`):

- **`acquisition_jobs`** — one row per acquisition. `id` is a uuid (for
  `kind='url'` it will mirror `acquire_jobs.id`; `acquire_jobs` stays
  authoritative for the URL engine). Carries `kind`
  (`album-hunt | auto-acquire | direct | track-search | url`), `method`
  (`slskd | ytdlp | spotdl | archive`), `state`
  (`active | done | failed | superseded`), `stage`
  (`downloading | organizing | scanning | processing | done | error`), the
  hunt metadata (`artist_name`, `album_title`, `lidarr_album_id`,
  `release_mbid`, `artist_mbid`, `genres_json`, `year`,
  `canonical_tracks_json`), `album_job_id` (the owned fallback-engine row, see
  below) and `source_ref` (primary peer or URL).
- **`acquisition_job_items`** — one row per expected file. `transfer_key` is
  the **exact** enqueued `username::filename` string — backslashes and case
  preserved, never normalized (the same contract `transfer_retries` proves
  against slskd's `getDownloads`). Item state:
  `downloading | completed | organized | scanned | failed | unavailable`.
  The row is **stable across peers**: when the fallback re-pulls a track from
  a new peer, `username/filename/transfer_key` are updated in place
  (`attempts`++) via `repointItem`, so `relative_path`/`song_id` accumulate on
  one row. `track_title` is the canonical title (given, or best-effort matched
  from the canonical tracklist via `titlesOverlap` at insert).

## Relationship to the older job tables

- **`album_jobs` stays** — permanently — as the cross-peer fallback engine's
  private table (it has its own sweep/revive lifecycle and ~6 readers). The
  unified job *owns* its fallback row via `album_job_id`;
  `AlbumFallbackService.recordJob` now returns the rowid so enqueue paths can
  link the two.
- **`acquire_jobs` stays** as the URL engine's table. The unified row is a
  mirror sharing the same uuid, dual-written at the same code sites (Phase 2).

## Write paths (enqueue-time recording)

All best-effort — a recording failure must never fail an enqueue that already
succeeded:

- `POST /albums/:id/hunt-download` (`routes/discography.ts`) — kind
  `album-hunt`, full Lidarr metadata (genres ?? artist genres, year from
  `releaseDate`, both MBIDs), items = the exact `filesToDownload`.
  `?replace=true` supersedes prior active unified jobs via
  `supersedeActiveJobs` alongside the album_jobs supersede.
- `acquireAlbum` (`services/album-acquire.ts`) — kind `auto-acquire` (shared
  core of the watchlist poller and Lidarr missing-list loop).
- `POST /api/downloads` (`routes/downloads.ts`) — kind `direct` for raw
  folder-browser grabs; no canonical metadata, artist/album are best-effort
  display hints parsed from the peer's folder segments.
- `POST /albums/:id/hunt-tracks` (`routes/discography.ts` +
  `TrackHunterService`) — kind `track-search`; `TrackHuntResult.downloads`
  reports what was actually enqueued (possibly several peers) and the route
  wraps them in one job with per-file `username`.
- `AlbumFallbackService` — on an alternate-peer pull or fresh-search recovery,
  `repointAcquisitionItems` re-points the owning job's items to the new peer
  (`repointOrAttachItem`: fuzzy `titlesOverlap` match restricted to
  non-completed items so an overlapping title can never mislabel a delivered
  file; unmatched recoveries attach as new items rather than being lost).

## Partial completion (a job never waits for unobtainable tracks)

Individual songs are never held back (the quarantine gate lands each track on
its own). The job's own lifecycle closes when **every item is terminal**:
`scanned`-and-landed, `failed` (transfer error), or `unavailable` (the
fallback gave up — `markMissingItemsUnavailable`). A job with some
`unavailable` items finishes as an honest partial ("11 of 13 · 2 unavailable"),
not an eternal spinner and not an error. `recomputeStage` derives
state/stage purely from item states (+ `library_songs.landed_at` for scanned
items) — idempotent under any watcher/scan/graduate interleaving. Safety
valves in `reconcileOnBoot`: items idle past 24h are failed (so a restart or
vanished transfer can't strand a job), and finished jobs are pruned 7 days
after they last moved (`updated_at`, so a just-closed job stays visible).

## Pipeline stage tracking (Phase 2 — shipped)

- **DownloadWatcher** (`download-watcher.ts`): on a new `Completed, Succeeded`
  transfer it calls `markItemCompleted` and attaches `jobMeta`
  (`jobMetaForTransfer`) to the `CompletedDownloadFile`; after organize it
  calls `markItemOrganized` with the post-move path; after the incremental
  scan it maps the new paths to `library_songs.id` (`markItemsScanned`) and
  recomputes each touched job's stage. All best-effort — job bookkeeping never
  breaks the pipeline.
- **LibraryOrganizer**: `applyJobCanonicalName` prefers the per-file `jobMeta`
  (artist/album) over the directory-keyed `jobLookup`, which fixes
  alternate-peer fallback folders that match no folder string. The dead
  duplicate default `jobLookup` in the watcher constructor was removed
  (production always injects the shared organizer from `index.ts`).
- **Fallback exhaustion**: `AlbumFallbackService.setState('exhausted')` marks
  the owning job's still-missing items `unavailable` and recomputes — the
  honest-partial close. `setState('done')` recomputes too.
- **Landing**: `graduatePending` (library-processing) calls
  `recomputeActiveJobStages` after every landing pass, closing jobs waiting in
  `processing`.
- **AcquireWatcher (URL)**: `submit` mirrors the job into `acquisition_jobs`
  (same uuid, kind `url`); `updateState`/`setStage` dual-write
  (queued/running → `active`); the boot orphan-fail updates the mirror rows in
  the same pass. `acquire_jobs` stays authoritative.
- **Boot + periodic hygiene**: `index.ts` runs `reconcileOnBoot` at startup and
  after every retry sweep (alongside `fallback.sweep()`).

## Read model + web feed (Phase 3 — shipped)

- `GET /api/downloads` enrichment now runs **stored transfer-key lookup first**
  (`enrichWithAcquisitionJobs` in `routes/downloads.ts`: per-file
  `jobMetaForTransfer`), with the legacy `(username, directory)` `album_jobs`
  match kept one release as fallback for pre-migration active downloads.
- **`GET /api/downloads/jobs`**: unified job feed (`listJobFeed`), newest
  first, with per-state progress
  (`{ expected, delivered, unavailable, failed }`) and a deep-linkable
  `albumId`.
- Core type `AcquisitionJobView` (+ `AcquisitionJobKind`) in
  `packages/core/src/types/acquire.ts`, re-exported through the web shim.
  `PipelineStage` gained **`processing`** (scanned but quarantined behind
  enrichment gates) — badge + stepper updated in `lib/pipeline-stage.ts`.
- Web: `TransferService.acquisitionJobs` polls the feed;
  `mergeAcquisitionJobs` (`lib/download-groups.ts`) folds jobs into the Active
  feed — a slskd row whose transfers finished adopts the job's post-download
  stage (organizing → scanning → processing → done) and its unavailable count
  ("11 of 13 · 2 unavailable" via the `download-unavailable` chip); active
  jobs whose transfers vanished from slskd render as their own rows; URL jobs
  are skipped (the AcquireJob lane already shows them).

## Metadata pre-fill (Phase 4 — shipped)

`applyJobMetadataPrefill` (`services/job-metadata-prefill.ts`), called from the
watcher's scan seam: freshly scanned songs whose job carries Lidarr
`genres`/`year` get them applied immediately — `setSongGenres` (join table +
mirrored primary column, the same helper the genre task uses) plus a file-tag
write, so the genre enrichment task's pending query naturally skips them and a
full rescan re-reads the value from the tag instead of wiping it.
**Fill-only-empty**: an existing tag or user metadata fix always wins.

## Rollout phases

1. **Schema + store + write-only recording** (shipped) — no readers, zero
   behavior change.
2. **Pipeline stage tracking** (shipped) — see above.
3. **Read model + web feed** (shipped) — see above.
4. **Metadata pre-fill** (shipped) — see above.
5. **Cleanup** (shipped) — the three legacy `album_jobs` readers now UNION the
   unified table, so track-search/direct acquisitions (which never create an
   `album_jobs` row) are covered too: download suppression
   (`getDownloadingGroupKeys`, `routes/library.ts`), the curator's protected
   keys (`loadProtectedKeys`, `library-curator.ts`), and the scanner's
   canonical-tracklist map (`canonicalByAlbum`, `library-scanner.ts`).
   `transfer-group-keys.ts` remains the permanent safety net for transfers
   with no job at all (enqueued outside NicotinD). `enrichWithAlbumJobs`
   remains one release as the legacy feed-label fallback.
