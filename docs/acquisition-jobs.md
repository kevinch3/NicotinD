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
  authoritative for the URL engine; `kind='import'` likewise mirrors an
  **item-less** row for an admin import — `import_jobs` is
  authoritative and `listJobFeed` reads that row's `files_total/files_done`
  as the progress, see [docs/import.md](import.md)). Carries `kind`
  (`album-hunt | auto-acquire | direct | track-search | url | import`), `method`
  (`slskd | ytdlp | spotdl | archive | import`), `state`
  (`active | done | failed | superseded`), `stage`
  (`queued | downloading | organizing | scanning | processing | done | error`;
  the column defaults to `downloading`, and a job created *before* its source has
  resolved anything — an addon URL job, an import — passes `queued` instead), the
  hunt metadata (`artist_name`, `album_title`, `lidarr_album_id`,
  `release_mbid`, `artist_mbid`, `genres_json`, `year`,
  `canonical_tracks_json`), `album_job_id` (the owned fallback-engine row, see
  below), `source_ref` (primary peer or the `addon:<id>:<jobId>` back-reference),
  `source_url` (the submitted link, for `kind='url'`) and `display_title` (what
  the Downloads card is *called* — deliberately not `album_title`, which is
  filing metadata; see docs/download-pipeline.md "Card titles").

  The read model (`listJobFeed` → `AcquisitionJobView`) ships `displayTitle`,
  `sourceUrl` and `destinationAlbums` alongside these, which is what lets the
  shared `downloadTitleFor` chain name a card without a second round-trip.
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
  display hints parsed from the peer's folder segments. **Post-scan album
  backfill (issue #223):** those enqueue-time segment guesses are noisy (or
  absent) and often don't match the album the file organizes into, so a direct
  grab used to land with no resolvable "where" — no album chip, no "Open in
  Library" deep-link, or worse `/unsorted`. Once the file has actually landed,
  `backfillDirectJobAlbum(db, jobId)` (called from the watcher's scan seam,
  right before `recomputeStage`) re-points the job's `artist_name`/`album_title`
  to the **canonical** album the scanned item resolved into
  (`acquisition_job_items.song_id` → `library_songs.album_id` → `library_albums`,
  dominant album on a multi-album grab). Because album ids are deterministic
  (`albumIdFor(artist,album)`), the feed's + `enrichWithAcquisitionJobs`'
  `albumId` now reproduce the real album. **Restricted to `kind='direct'`** —
  hunt/auto-acquire/track-search jobs carry authoritative canonical metadata that
  a post-scan guess must never overwrite; best-effort, so a missing
  `library_albums` (minimal test DB) or an unscanned item is a clean no-op.
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
items) — idempotent under any watcher/scan/graduate interleaving.

**Safety valves in `reconcileOnBoot`** (run at boot *and* on every retry sweep,
in this order):

1. **`reconcileOrganizedItems` — rescue before failing (issue #262).**
   `markItemsScanned` only ever runs over the relative paths of the scan batch
   that just finished, so an item organized by a *different* batch (a fallback
   wave landing after the primary's scan, a duplicate copy deduped into an
   existing path, a scan that errored mid-batch) is never revisited. It sits at
   `organized` forever and `recomputeStage` correctly refuses to close a job
   whose items are non-terminal — which is what stranded six prod jobs at
   `state=active, stage=scanning`. The measurement that settled it: of the 28
   stranded items, **20 already had a `library_songs` row at their exact
   recorded path**. Nothing was ever going to look again. This pass re-resolves
   every `organized` item against `library_songs.path` and marks it `scanned`.

   Matching is `COLLATE NOCASE` here and in `markItemsScanned`: the organizer
   records the path it wrote, the scanner mints `library_songs.path` from tags,
   and the two disagree on casing often enough to strand items on their own
   (prod: `01 - ¿Quién te dijo eso.opus` organized vs `01 - ¿Quién Te Dijo
   Eso.opus` scanned).

   **`COLLATE NOCASE` folds ASCII case only, never diacritics**, and leaving
   accent drift to the idle valve turned out to be the wrong trade. Measured on
   prod: a job sat at `state=active, stage=scanning` for **23 hours** with four
   organized items whose files had been present the entire time — the organizer
   had written `Los Autenticos Decadentes/…` while the library held
   `Los Auténticos Decadentes/…`. The valve would eventually have marked those
   items *failed*, recording a false partial for an album that downloaded
   completely.

   So an exact/NOCASE miss now falls back to an **accent-folded** comparison,
   using the same `fold()` (`@nicotind/core`, NFD + strip combining marks) that
   search matching and hunt scoring already use for exactly this
   Latin-American accent gap. SQLite cannot unaccent in SQL, so the folded
   index is built in JS — **lazily, and only once an exact match has already
   failed**, so the common path costs nothing.

   Replayed against the live prod DB: of 6 stuck `organized` items, **0**
   resolved under the old exact/NOCASE match, **4** are rescued by the fold
   (closing that job), and **2** stay unresolved — those are genuinely missing
   files, and the valve is the right answer for them. Folding must not invent a
   match, which is its own test.
2. **The 24h idle valve.** Items idle past 24h are failed, so a restart or a
   vanished transfer can't strand a job. `NON_TERMINAL_STATES` already covers
   `organized`, not just `downloading`; it runs *after* the rescue so an item
   whose file genuinely landed is never written off.
3. **TTL prune.** Finished jobs are pruned 7 days after they last moved
   (`updated_at`, so a just-closed job stays visible).

**Over-counted `unavailable` (issue #262).** A prod job reported "7 of 240 ·
233 unavailable" for a 14-track album. The cause was not repeated attaches, as
first suspected: the hunt's winning folder was the peer's entire
`Joe Satriani\` discography — 254 files — and every one of them was enqueued
and itemised, 227 of them matching no canonical track (`track_title IS NULL`).
`filesForCanonicalTracks` (`library-completeness.ts`) now scopes a chosen
folder's files to the album's canonical tracklist before `filesMissingOnDisk`,
at both enqueue sites (`album-acquire.ts`, `routes/discography.ts`). It is
deliberately conservative — with no tracklist, or when nothing matches it, the
files pass through unchanged, so it can never turn a working hunt into an empty
download. A canonical track whose filename is too divergent to match is dropped
and recovered by the fallback's fresh-per-track search, the same path that
handles any other missing track.

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
- **Boot + periodic hygiene**: `index.ts` runs `reconcileOnBoot` at startup
  (`:145`) **and every 60 s** on its own `jobHygieneTimer` interval (`:304`),
  aliased there as `reconcileAcquisitionJobs`. The name is a historical
  misnomer — it has not been boot-only since the slskd engine moved addon-side.
  Worth knowing because a grep for `reconcileOnBoot` finds only the import and
  reads as "boot only", which is how issue #710 came to blame a scheduling gap
  that does not exist.

## Cursor-stranded ingest (`ingestStrandedJobs`)

`AddonJobPoller.pollAddon` polls `listJobs(cursor)` and only ever advances the
cursor, which the addon applies as `?since=`. A job that stops updating — which
every job does once terminal — therefore drops out of the listing as soon as any
other job pushes the cursor past it. That is fine for a finished job, and data
loss for one core has not finished collecting: `ingestReadyItems` runs only for
jobs the poll returns, so an already-downloaded file core had not fetched yet is
never fetched again.

Nothing else recovered it, because the two components that could were each
behaving correctly:

- `maybeReleaseAddonJob` refuses to delete the addon-side job while items are
  `completed` with a null `relative_path` — precisely *because* those files are
  still needed.
- `reconcileOrphanedJobs` fails only jobs the addon 404s. This job is alive, so
  it is left alone: "the normal poll owns its lifecycle." The normal poll had
  stopped owning it.

The files then sat until the 24 h idle valve marked them `failed` and the
addon's 7-day janitor deleted them. Measured on prod: 11 files across two jobs
(issue #725).

`ingestStrandedJobs` closes the loop — it enumerates active jobs of this addon
holding items with outstanding ingest (the same predicate `maybeReleaseAddonJob`
uses), skips the ones the poll already handled this tick, re-fetches each by
`getJob`, and runs the normal ingest → outcome → release sequence. A 404 routes
to `failOrphanedJob`, since a forgotten job's files are genuinely gone. It is
bounded by the number of genuinely stuck jobs, which is normally zero.

**It is throttled to once a minute per addon**, well below the poller's 5 s
tick. The normal result set is empty, but a job whose file the addon can no
longer serve stays in it until the 24 h valve clears it — at tick frequency that
would be thousands of re-fetch attempts against the addon for one dead file.
`strandedSweepIntervalMs` overrides the interval (tests set 0).

**It keys on outstanding items, never on the job row's `updated_at`.**
`recomputeStage` rewrites `updated_at` on every call even when the stage is
unchanged, so a stranded job reads as seconds-idle while its items are
hours-idle — any staleness-gated sweep would silently never fire on exactly the
rows it exists to catch.

## Read model + web feed (Phase 3 — shipped)

- `GET /api/downloads` enrichment now runs **stored transfer-key lookup first**
  (`enrichWithAcquisitionJobs` in `routes/downloads.ts`: per-file
  `jobMetaForTransfer`), with the legacy `(username, directory)` `album_jobs`
  match kept one release as fallback for pre-migration active downloads.
- **`GET /api/downloads/jobs`**: unified job feed (`listJobFeed`), newest
  first, with per-state progress
  (`{ expected, delivered, unavailable, failed }`), a deep-linkable
  `albumId`, and per-track `items: { title, status: TrackStatus }[]` — each
  `acquisition_job_items.state` (`downloading|completed|organized|scanned|
  failed|unavailable`) is mapped onto the shared `TrackStatus` union
  (`completed|organized|scanned → done`, `unavailable → skipped`,
  `failed → failed`, `downloading → downloading`, anything else → `pending`),
  so the frontend renders slskd hunts' per-track status the same way it
  already does for URL-acquisition jobs' `AcquireJob.tracks`.
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
- **One job = one card** (`collapseJobMembers`, issue #261): every slskd folder
  group sharing a **`jobId`** (multi-peer hunts, CD1/CD2 subfolders,
  alternate-peer fallback pulls) collapses into a single card keyed
  `job:<id>`. Progress prefers the job's item tallies ("9 of 13") over
  per-folder file counts; the card stays on the most-active member's stage
  while anything is still downloading. The collapsed `DownloadItem` carries
  `memberKeys` and the Downloads page fans cancel/retry/remove out to every
  member folder group (`groupsForItem`).

  **Why the key changed from `albumId` to `jobId`.** The server has recorded
  the transfer↔job link at enqueue time since Phase 1, but the client threw the
  job id away and re-derived card identity from `albumIdFor(artist, album)`.
  One hunt therefore split into several cards whenever that derived key failed
  to line up — and there are many ways for it to fail, which is why the symptom
  kept being reported and re-patched. Prod showed one Luis Fonsi hunt (one job)
  rendering as five cards, its files in flight from five peers. Keying on the
  job the server already recorded removes the re-derivation entirely: a new
  acquisition path (a new source adapter, a new fallback strategy, a multi-disc
  release) inherits correct grouping for free, because it necessarily creates a
  job. It also fixes the converse bug — two *separate* jobs for the same album
  are now two cards, where the `albumId` collapse wrongly merged them.

  `enrichWithAcquisitionJobs` ships the id as `AlbumJobMeta.jobId`, and
  `listJobFeed` ships a per-peer **`sources[]`** (`{username, fileCount,
  state}`, grouped from `acquisition_job_items`, worst-state-first per peer via
  `dominantItemState`) so the card renders a `Sources (N)` disclosure instead of
  the feed splitting per peer.
- **Unlinked transfers collapse into one group** (`collapseUnlinked`): slskd
  transfers matching no job — genuinely external downloads, plus any whose
  linkage was lost — render as a single `unlinked` row carrying every member
  key, so they stay visible and cancellable but never appear as N loose cards.
  `repointAcquisitionItems` (`album-fallback.service.ts`) still returns early
  when `acquisitionJobIdForAlbumJob` misses, but now `log.warn`s first: a
  transfer NicotinD itself enqueued should never end up unlinked, and nothing
  re-links it after the fact, so the loss must at least be visible.

  Transfers enqueued before this feature deployed have no job rows, so they
  land in the unlinked group until they finish/are cleared — expected, one-time.

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
   canonical-tracklist map (`canonicalByAlbum`, `library-scanner.ts`). The UNION
   itself is no longer hand-written three times: all three call the shared
   **`jobAlbumPairs(db, {activeOnly?})`** / **`jobCanonicalTracklists(db)`**
   helpers in `acquisition-job-store.ts` (one source, resilient to missing
   tables). `transfer-group-keys.ts` remains the permanent safety net for
   transfers with no job at all (enqueued outside NicotinD). The legacy
   folder-string **`enrichWithAlbumJobs` feed-label fallback is retired** — the
   feed now labels download folders purely by the stored per-file transfer key
   (`enrichWithAcquisitionJobs`), since every NicotinD-initiated album download
   writes those keys and the fallback repoints them; external transfers fall
   back to folder-name parsing on the web.
6. **Downloads feed 3→2 endpoints** (deferred follow-up) — the downloads page
   still merges three sources: slskd `/downloads`, the unified `/downloads/jobs`,
   and `/acquire/jobs` for URL jobs. Collapsing the URL lane into the unified feed
   is **not just a fetch removal**: `/acquire/jobs` (via `TransferService`) is the
   source of truth for every URL-job *action* — the "Clear finished" buckets and
   the retry/cancel/open-playlist handlers (`downloads.component.ts`) — and the
   unified `AcquisitionJobView` deliberately skips URL jobs (they carry
   url/playlist/dest-album/track fields the `acquisition_jobs` mirror lacks). Doing
   it means `LEFT JOIN acquire_jobs` into `listJobFeed` for `kind='url'` **and**
   rewiring those web handlers onto the enriched feed. Left as a follow-up: higher
   regression risk on the URL-download UX for a one-endpoint gain. `/acquire/jobs`
   stays regardless (the search page's link-intent card polls it).
