# Download Pipeline

## Release-type model — albums, EPs & singles (Spotify-style)

NicotinD is album-centric, but loose tracks (a YouTube single, a Soulseek peer with no album tag) are **first-class** rather than hidden. Every `library_albums` row carries a `classification`: `album` | `ep` | `single` | `compilation` | `unknown`.

### Where a file lands on disk

`LibraryOrganizer` places tracks at `<Artist>/<Album>/<Track>` when an album is known, or `<Artist>/Singles/` as the fallback bucket.

- **Multi-file downloads**: `classifyFolder` in `compilation-tagger.ts` derives the album from the peer folder name (single-artist consolidation path).
- **Single-file downloads**: `deriveFolderTags` in `library-organizer.ts` calls `inferFolderAlbum` (`path-inference.ts`) to derive the album from the peer directory's leaf segment when the ID3 album tag is missing. Generic folder names ("downloads", "src", "music", …) and folders that just echo the artist name are blocked by `looksLikeGenericFolder` so they don't become fake albums.

The organizer **no longer force-writes `album="Singles"`** for the bucket fallback — it leaves the album tag empty so the scanner can derive a per-track single (below). The file still physically lives under `<Artist>/Singles/`; only its canonical identity changes.

### Un-bucketing at scan time (each loose track = its own single)

`library-scanner.ts` `resolveTags` calls the exported pure `isLooseSinglesBucket(dir, album)`: when a track has no usable album (`Unknown Album`) **or** sits in the synthetic `<Artist>/Singles/` bucket, its album becomes the **track title**. So `albumIdFor(artist, title)` mints a distinct album per loose track — each surfaces as its own single card instead of all collapsing into one hidden `Singles` bucket. Format-duplicates of the same single still collapse via the shared normalized-title group key (`selectAlbumTracks`). Legacy files the old organizer force-tagged `"Singles"` migrate automatically on the next full rescan (the folder-name check overrides the stale tag). *Trade-off:* a real compilation literally titled "Singles" in `<Artist>/Singles/` now splits into per-track cards — rare and arguably correct.

### Metadata-first classification (`LibraryCurator`)

`reclassifyAll()` runs after every scan and classifies each album:

1. `manual_override` wins (user choice sticks across rescans).
2. **Authoritative metadata** — the Lidarr/MusicBrainz `albumType` from the `library_release_meta` side table (`release-meta-store.ts`, keyed on `albumId`, off the scanner-managed rows so it survives prunes). A known catalog release is never hidden.
3. **Heuristic fallback** — `1 → single`, `2–6 → ep`, `7+ → album`; the `[Unknown Album]/[Unknown Artist]` mega-bucket and unknown-identity single rows are hidden.

### Grid exclusion (centralized) & where singles surface

The main Albums grid stays album-only via a **single** definition, `GRID_CLASSIFICATION_SQL = classification IN ('album','compilation')` in `routes/library.ts`, applied by `GET /api/library/albums` (so no listing endpoint can re-pollute the grid by forgetting the filter). Singles & EPs surface elsewhere:

- `GET /api/library/artists/:id` returns `{ artist, albums, singlesAndEps }` (the web renders a **Singles & EPs** section).
- `GET /api/library/singles?type=&size=&offset=` is the dedicated singles/EPs listing (the web's Library → **Singles** tab).

### Ingest-time enrichment (best-effort)

`SingleEnrichmentService` (`services/single-enrichment.service.ts`), wired into `AcquireWatcher` for URL acquisitions, runs **after** the incremental scan: for each just-scanned loose single/EP it does a best-effort `CatalogService.search("<artist> <title>")` Lidarr/MusicBrainz lookup and writes the canonical **release type** (`release-meta-store`) + **album/artist artwork** (`artwork-store`) keyed on the scanner's ids, then the caller reclassifies. It **degrades gracefully**: Lidarr unconfigured / lookup failure / no match → the heuristic classification + on-disk art stand. Only wired when Lidarr is configured (the callback is `undefined` otherwise).

Files mislabeled as Singles before the original organizer fix can still be repaired with `bun run packages/api/src/scripts/repair-singles.ts`.

---

## Duplicate prevention (two layers)

Shared logic lives in `packages/api/src/services/album-dedupe.ts` (`dupKey`/`pickKeeper`/`dedupeFolder`), reused by the manual `repair-album-dupes.ts` script.

1. **Format preference** — when config `downloads.preferFlacSkipMp3` is on, `LibraryOrganizer.placeFile` drops an incoming MP3 (and removes its source) if a same-title FLAC already sits in the destination album folder.
2. **Auto-dedupe** — after each batch, `organizeBatch` runs `dedupeFolder` on every real `<Artist>/<Album>` dir it touched (never `Singles`/unsorted), removing collision-suffix/mixed-format true copies and returning `dedupedBasenames` so `DownloadWatcher` prunes the matching `completed_downloads` rows. On by default (`autoDedupe`).

---

## Album deletion (reliability)

`DELETE /api/library/albums/:id` (`packages/api/src/routes/library.ts`) is **folder-first**: `tryDeleteAlbumFolder` recursively removes the album's `<Artist>/<Album>` directory in one `rmSync` (taking cover art + sidecars with it) when all tracks share one album-specific folder, guarded against the music root, bare `<Artist>` roots, shared `Singles` folders, and folders holding foreign audio. Otherwise it falls back to the per-file `deleteOne` chain (which sources the path from `library_songs`, with stale-path/renamed-folder fuzzy recovery).

It then **synchronously** deletes the canonical rows (`library_songs`, `library_albums`, `completed_downloads`) in one transaction. No tombstone/async-scan reconciliation needed: the native scanner reads disk directly and the files are gone, so a later rescan can't resurrect the album.

---

## Untracked downloads (legacy `relative_path`)

Rows predating the organizer have `relative_path IS NULL` and are invisible to deletion/tombstoning. `backfillRelativePaths` (`packages/api/src/services/untracked-backfill.ts`, CLI `scripts/backfill-untracked.ts`, dry-run unless `--apply`) indexes the music dir by basename and fills in unambiguous matches. `GET /api/library/untracked` (admin) lists rows still lacking a path.

---

## URL acquisition (yt-dlp / spotdl)

`AcquireWatcher` (`packages/api/src/services/acquire-watcher.ts`) + `YtdlpService` (`ytdlp.service.ts`) download audio from a pasted/shared URL (`POST /api/acquire`, backend auto-detected: `spotify.com` → spotdl, else yt-dlp), stage it, then run it through the **same shared `LibraryOrganizer` + incremental scan** as Soulseek downloads.

Availability is gated by **both** the `acquire.{ytdlp,spotdl}.enabled` config flag **and** the binary being present on PATH (`isBinaryAvailable`, cached) — the route returns 503 otherwise. Both default **on** (`config/default.yml`); the production **Dockerfile installs `yt-dlp` + `spotdl`** via pip.

Historical gotcha: the `enabled` flag used to be dead config — only binary presence was checked — and the image shipped neither binary, so acquisition always 503'd; both are fixed.

### Playlists (yt-dlp)

A `watch?v=…&list=…` or `playlist?list=…` URL downloads the whole playlist. Two behaviors make this robust:

- **Partial failures don't sink the job.** yt-dlp runs with `--ignore-errors`, so unavailable/private/deleted videos are skipped instead of aborting at the first one. Crucially, **success is decided by whether audio files landed, not by the exit code** — yt-dlp exits non-zero whenever *any* item failed, even after downloading every other item, so the runner (`acquire/process.ts`) ignores the exit code when `collectAudioPaths` found files and only rejects on `0 files AND non-zero exit`. `AcquireWatcher.run` then marks the job failed only when the resolve produced zero files. A playlist where 40/41 items succeed ingests those 40. Earlier iterations that trusted `--ignore-errors` to yield a zero exit, or that keyed off the exit code, discarded all 40 — the staged files were cleaned up unused.
- **The job label shows the playlist name.** yt-dlp emits `[download] Downloading playlist: <name>` at the start; `parseYtdlpPlaylistTitle` captures it and the plugin calls `ctx.emitLabel(jobId, name)` → `acquire_jobs.label`, so the Downloads row shows the playlist title instead of the raw URL (the web falls back to a shortened URL when `label` is null). `emitLabel` is part of `PluginHostContext`.
- **Actionable errors.** When a run does fail, the runner stores the captured `ERROR:` lines (the real cause) rather than the last 2 KB of download-progress spam.

### Downloads UI integration

Completed (and in-progress/failed) acquire jobs appear in the **Downloads → Active** tab as a "URL Downloads" section alongside Soulseek transfers — same page, no separate UI. The lifecycle each row shows:

- **Queued / running**: progress bar (files done/total) or indeterminate pulse; cancel (×) button.
- **Done** (`"In Library"`): the files are already in the library. Dismiss (×) removes the job record; the library entry remains.
- **Failed**: truncated error text, **Retry** button (re-submits the same URL as a new job, deletes the old row), Dismiss.

`AcquireJob` shape is exported from `@nicotind/core` so the web package can type-check against it without a cross-package dep on `@nicotind/api`. Done/failed jobs older than 7 days are pruned at startup (`AcquireWatcher` constructor) so the list stays bounded. The Downloads Active tab badge counts both slskd in-progress folders and active acquire jobs.

---

## Download list metadata (`AlbumJobMeta`)

`GET /api/downloads` annotates each in-flight folder whose `(username, peer directory)` matches an **active `album_jobs`** row with `albumJob: { artistName, albumTitle, canonicalTrackCount }` (`enrichWithAlbumJobs` in `routes/downloads.ts`; type in `@nicotind/core`). This lets the Downloads UI show "Artist — Album · N of M tracks" instead of the noisy peer folder name (e.g. "(1995) Toque").

The web groups transfers via the pure `lib/download-groups.ts` (`groupByAlbum`/`albumGroupTitle`/`albumGroupTotal`), which prefers the hunt metadata and falls back to the peer folder name + file count for **direct (non-hunt)** downloads that have no job.

---

## Acquisition provenance (`acquisitions` table)

Every acquired file records **how / where-from / when** it arrived, so a library track can answer "where did this come from?" without fragile after-the-fact guessing. The `acquisitions` table (`db.ts`) is keyed on the file's final on-disk `relative_path` — the **same join `library_songs.path` already uses** — with `method` (`AcquisitionMethod`: `slskd`/`ytdlp`/`spotdl`/`archive`/`unknown`), `source_ref` (slskd peer username or the acquire URL), `stage`, `started_at`, `completed_at`. It follows the `library_artwork` / `library_release_meta` side-table pattern (survives full rescans/prunes; not owned by the scanner).

Writes happen **at download time** in the two places that already produce the final path — no fuzzy timing reconstruction:

- **slskd** — `download-watcher.ts` `recordSlskdAcquisition()`, called in the post-organize loop right beside `updateRelativePath` (method `slskd`, `source_ref` = peer username).
- **URL** — `acquire-watcher.ts` `ingest()`, one row per organized file (method = `methodForBackend(pluginId)`, `source_ref` = URL).

Both go through `acquisition-store.ts` (`recordAcquisition` upsert / `recordAcquisitionIfMissing` for backfill / `getAcquisitionByPath` read), which swallows DB errors so provenance is never able to break the pipeline. **Caveat:** a file moved by a later rescan changes its path and orphans its acquisition row — the same fragility `library_songs.id` already carries.

### Pipeline stage on acquire jobs

`acquire_jobs` gains `stage` (`PipelineStage`: `queued → downloading → organizing → scanning → done`, or `error`) and `storage_path` (the canonical album dir the files landed in). `AcquireWatcher` sets `stage` at each transition (`setStage`) and records `storage_path` once organize completes (`setStoragePath`); both surface via `mapRow` on `GET /api/acquire/jobs`. Note `state` (`done`) is set when the *download* succeeds — **before** the organize/scan ingest — so `stage` is the finer-grained signal (it reaches `done` only after the full pipeline finishes). slskd transfers organize/scan as a debounced **batch**, so their live stage is derived job-level at read time rather than stored per file.

### Surfacing provenance on a track + backfill

`GET /api/library/songs/:id/acquisition` (`routes/library.ts`) joins the song's `path` against `acquisitions` and returns `SongAcquisition` (`{ method, sourceRef, acquiredAt, storagePath }`) — `404` for an unknown song, `null` for a song with no recorded provenance (legacy imports). The web surfaces it as an **"Acquisition" section** in the existing `track-info-sheet` bottom drawer (between File and Processing history), with a method badge from the pure `lib/acquisition-method.ts` (`methodBadge`) and `ApiService.getSongAcquisition`; an unrecorded song reads "Source not recorded".

Songs that predate the table are filled in once at boot by `acquisition-backfill.ts` (`backfillAcquisitions`), wired into the post-scan path in `index.ts` and guarded by an `acquisitions_backfilled` `library_sync_state` marker (idempotent; `{ force: true }` for tests). It joins `library_songs.path → completed_downloads.relative_path` and derives the method from the recorded `username` (`acquire:<jobId>` → the job's `backend`, else `slskd`). Songs with no `completed_downloads` link are left unrecorded (shown as "Unknown source") rather than guessed.
