# Download Pipeline

## Process-before-landing (quarantine gate)

A completed download is scanned into `library_songs` but does **not** appear in the
library until its **required processing steps** finish. New rows land quarantined
(`landed_at IS NULL`) and are hidden from every listing; the windowed processor
graduates them (sets `landed_at`) once their gate steps are done — see the **Landing
gate** section of [library-processing.md](library-processing.md) for the graduation
predicate, the per-task `gates` flag, the availability guarantee, and the 24h safety
valve. `scanIncremental` fires an eager `kickEager()` right after organize+scan so
gate steps run immediately (out of window) and the download surfaces as soon as it's
ready.

**Listing coverage** — quarantine is enforced at query time, mirroring the
`downloadingExclusion` pattern (`routes/library.ts`):

- `quarantineExclusion(db)` (cached ~4s, fast-path empty when nothing is quarantined)
  excludes any album with an un-landed track from `/albums`, `/compilations`,
  `/singles`, `/artists/:id` albums, `/artists/:id/appears-on`; `/albums/:id` 404s
  while quarantined.
- `landed_at IS NOT NULL` filters the song/artist surfaces: `/artists` (grid),
  `/artists/:id/songs`, `/genres/songs`, `/random`, `/recent-songs`, `/songs/:id/similar`,
  local search (`library-provider.ts`), radio candidate pools (`routes/radio.ts`),
  and the playlist generator + automated-playlist recipes.
- Per-download step visibility: `GET /api/admin/processing/queue` returns quarantined
  songs grouped by album with per-step badges (downloaded ✓ · bpm ✓ · key ⏳ · mood …),
  rendered under the Admin → Library processing panel.

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

## Duplicate prevention (three layers)

Shared logic lives in `packages/api/src/services/album-dedupe.ts` (`dupKey`/`pickKeeper`/`dedupeFolder`), reused by the manual `repair-album-dupes.ts` script.

1. **Format preference** — when config `downloads.preferFlacSkipMp3` is on, `LibraryOrganizer.placeFile` drops an incoming MP3 (and removes its source) if a same-title FLAC already sits in the destination album folder.
2. **Auto-dedupe** — after each batch, `organizeBatch` runs `dedupeFolder` on every real `<Artist>/<Album>` dir it touched (never `Singles`/unsorted), removing collision-suffix/mixed-format true copies and returning `dedupedBasenames` so `DownloadWatcher` prunes the matching `completed_downloads` rows. On by default (`autoDedupe`).
3. **Cross-edition folder consolidation** — auto-dedupe is *per folder*, so duplicates split across sibling edition folders (`<Artist>/Ultraviolence/` + `<Artist>/Ultraviolence (JP Deluxe Edition)/`) were never collapsed: album-grouping merges them into one *card* but they stay duplicated on disk. So `placeFile` now resolves the destination through `findCanonicalAlbumFolder(artist, album)` — it reuses an existing same-album folder by the edition-collapsing `albumGroupKey` (a per-batch readdir cache covers on-disk siblings *and* dirs created earlier in the same batch; it picks the fullest match, preferring the shortest/base title on a tie). Deluxe/remaster/JP/year-tagged editions therefore land in **one** `<Artist>/<Album>` dir and layer 2 then collapses the cross-edition true-dups. The active-job canonical name (`applyJobCanonicalName`) still wins when present; the feature is gated by `dedupeAcrossEditions` (default on); `normalizeForGrouping` keeps genuinely distinct titles ("Greatest Hits" vs "II") and live albums separate. **Editions already split on disk** (acquired before this) are merged by the existing `scripts/repair-album-folders.ts` (group by `albumGroupKey` → fullest canonical → move files in → trim to the recorded Lidarr tracklist or `dupKey` → drop empty siblings; dry-run unless `--apply`).

---

## Lossless → Opus standardization (storage + web playback)

FLAC is overkill for web streaming and large on disk. `downloads.transcodeLossless` is **default-on at 192 kbps** (config / `NICOTIND_TRANSCODE_LOSSLESS_ENABLED` + `NICOTIND_TRANSCODE_LOSSLESS_BITRATE`; set `enabled:false` to keep originals). When enabled, lossless downloads are transcoded to Opus and **already-lossy files (MP3/AAC/…) are left untouched**. The lossless set is shared (`isLossless()` in `library-track-select.ts`); the encoder is `post-download-transcode.ts` `transcodeToOpus()` (ffmpeg `libopus`, replace-in-place: write `<name>.opus`, drop the original). Everything is gated on `ffmpegAvailable()`.

**Detection is codec-aware, not extension-only** (`isLosslessFile()` in
`post-download-transcode.ts`): unambiguous extensions (flac/wav/aiff/ape/wv)
are decided without IO, but `.m4a`/`.m4b`/`.mp4` are probed with
music-metadata (`format.lossless`) because **ALAC (Apple Lossless) ships in
the exact same container as lossy AAC** — the `alac` entry in the extension
set never matches real files. ALAC matters doubly: it's lossless (storage) and
**no browser can decode it** (Firefox: `NS_ERROR_DOM_MEDIA_METADATA_ERR`,
Chrome likewise), so an ALAC file that slips through is unplayable in the web
UI whenever server transcoding is off. Found in real use 2026-07-07: 63 ALAC
`.m4a`s across 8 albums had bypassed the standardization. A probe failure
(unreadable/corrupt file, music-metadata absent) answers `false` and the file
is left untouched. Both the ingest hook and the existing-library migration use
`isLosslessFile`, so a library pass (`convert-library.ts` / admin
`POST /api/admin/transcode-library`) also sweeps up historical ALAC.

### New downloads (no identity churn)

The hook fires in `LibraryOrganizer.placeFile()` **after the move and before the incremental scan**. Because the scanner only ever sees the final `.opus` path, the song's path-derived `songId` is computed once — no orphaned curation, and format-preference dedup keeps working (all kept files are opus). A transcode failure is best-effort: it logs and leaves the original in place.

### Existing library (`transcodeLibraryToOpus`, the careful part)

`services/library-transcode.ts` converts the lossless files already in the library — via `scripts/convert-library.ts` (`--apply`, optional `--bitrate`; dry-run reports candidates) or admin `POST /api/admin/transcode-library` (`?dryRun=1`). Re-encoding changes a file's extension → its relative path → its derived `songId` **and** its `acquisitions` key. Album-keyed data (`library_artwork`, `library_release_meta`, classification, all keyed on the tag-derived `albumId`) is unaffected and survives; song-keyed data does not, so **per file** the job:

1. reads the old `library_songs` row (`id`, `path`, `starred`, `hidden`);
2. transcodes on disk (FLAC → opus, original removed);
3. **deletes the stale lossless row first**, then `scanPaths([newRel])` inserts the new opus row and recomputes the album aggregate counting only it;
4. carries `starred`/`hidden` onto the new id and re-points `playlist_songs.song_id` + `acquisitions.relative_path` (no FK on `song_id`).

Returns `{ candidates, converted, skipped, failed, bytesReclaimed }`.

---

## Album deletion (reliability)

`DELETE /api/library/albums/:id` (`packages/api/src/routes/library.ts`) is **folder-first**: `tryDeleteAlbumFolder` recursively removes the album's `<Artist>/<Album>` directory in one `rmSync` (taking cover art + sidecars with it) when all tracks share one album-specific folder, guarded against the music root, bare `<Artist>` roots, shared `Singles` folders, and folders holding foreign audio. Otherwise it falls back to the per-file `deleteOne` chain (which sources the path from `library_songs`, with stale-path/renamed-folder fuzzy recovery).

It then **synchronously** deletes the canonical rows (`library_songs`, `library_albums`, `completed_downloads`) in one transaction. No tombstone/async-scan reconciliation needed: the native scanner reads disk directly and the files are gone, so a later rescan can't resurrect the album.

The same transaction also **prunes the now-orphaned aggregate rows** so a deleted album doesn't linger until the next *full* scan: the `library_artists` row (deleted if no releases/songs remain, else its `album_count` corrected — via the shared `pruneOrphanArtist`, `services/library-aggregates.ts`, also reused by the metadata-fix re-point), the album's `library_artwork` row, and an emptied `library_genres` row. So deleting an artist's only release also removes the artist from search and the empty artist page immediately.

---

## Untracked downloads (legacy `relative_path`)

Rows predating the organizer have `relative_path IS NULL` and are invisible to deletion/tombstoning. `backfillRelativePaths` (`packages/api/src/services/untracked-backfill.ts`, CLI `scripts/backfill-untracked.ts`, dry-run unless `--apply`) indexes the music dir by basename and fills in unambiguous matches. `GET /api/library/untracked` (admin) lists rows still lacking a path.

---

## URL acquisition (yt-dlp / spotdl / archive.org)

`POST /api/acquire` routes a pasted/shared URL to an enabled `resolve`-capable **plugin** via `registry.getEnabledForUrl()` — **no hardcoded backend detection** (the old `detectBackend` enum that special-cased `spotify.com → spotdl, else yt-dlp` is gone). The resolve plugins are **yt-dlp**, **spotdl**, and the pure-JS **archive.org** backend (pasting an `archive.org` item URL routes to the last). Plugins **stage files only**; `AcquireWatcher` (`packages/api/src/services/acquire-watcher.ts`) owns the job records + ingest, running staged files through the **same shared `LibraryOrganizer` + incremental scan** as Soulseek downloads. The route returns **503** when no enabled plugin can handle/serve the URL. → See [plugins.md](plugins.md) for the plugin model.

Availability is gated by **both** the plugin's enable-state **and** (for yt-dlp/spotdl) the binary being present on PATH (`isBinaryAvailable`, cached). The production **Dockerfile installs `yt-dlp` + `spotdl`** via pip.

Historical gotcha: the `enabled` flag used to be dead config — only binary presence was checked — and the image shipped neither binary, so acquisition always 503'd; both are fixed.

**Restart reconciliation**: `AcquireWatcher`'s constructor marks any job still `queued`/`running` as `failed` ("Interrupted by a server restart — use Retry"). The downloader child process dies with the server, so nothing can ever advance those rows; before this they sat as stuck-forever "running" entries in the Downloads feed after every redeploy (found in real use 2026-07-13: an 893-track spotdl playlist job frozen at 0/893 across restarts).

**Resume after truncation**: a job's staging directory is only deleted once its *full* pipeline (download → organize → scan) succeeds — a failed job (restart, crash, or any other mid-run death) leaves its downloaded files on disk. `retryJob()` resumes that same job id (and therefore the same staging dir, since `pluginStagingDir(pluginId, jobId)` is deterministic) instead of starting a brand-new job with an empty directory. This backend-generic mechanism applies uniformly to every acquisition plugin (yt-dlp, archive, spotdl); the spotdl plugin additionally passes `--overwrite skip` so already-downloaded tracks aren't re-fetched, turning a truncated 893-track retry into "pick up the ~200 remaining tracks." That `--overwrite skip` flag is spotdl-specific — yt-dlp has its own native skip/resume behavior for files already on disk, and archive's plain file-stream write means a resumed archive job still re-downloads everything into the same dir (harmless, but not a resume speedup). Staging dirs are swept on success, on manual `deleteJob`, and by the 7-day stale-job janitor, so nothing accumulates indefinitely.

### YouTube bot-check mitigation (PO tokens + cookies)

Found in real use 2026-07-13: **every** spotdl job failed with "Download produced no audio files". spotdl resolves Spotify metadata fine, but each YouTube fetch died on yt-dlp's `Sign in to confirm you're not a bot` — YouTube had bot-flagged the server's egress IP (all player clients + IPv4/IPv6 affected, so it's the IP, not the client fingerprint). Three stacked mitigations, all baked into the deployment:

1. **Deno in the image** (Dockerfile): yt-dlp needs a JS runtime to solve YouTube's player signature challenges; without one many downloads fail regardless of bot-flagging. The pip line also `--upgrade`s yt-dlp every image build (YouTube continuously breaks old versions) and installs `bgutil-ytdlp-pot-provider`.
2. **PO-token provider** (docker-compose `bgutil-provider` service): YouTube demands "proof of origin" tokens from unrecognized clients; the bgutil companion service generates them and the pip-installed yt-dlp plugin fetches them automatically (spotdl included — same python env). The service runs with `network_mode: "service:nicotind"` so the plugin's default base URL `http://127.0.0.1:4416` works with zero per-invocation config (extractor-args can't be threaded through spotdl).
3. **Account cookies (`cookiesFile`)** — the only reliable unblock once an IP is *hard*-flagged (verified: valid PO tokens still got `LOGIN_REQUIRED`). Both plugins take a `cookiesFile` config (`acquire.ytdlp.cookiesFile` / `acquire.spotdl.cookiesFile`, also settable per-plugin via `PUT /api/plugins/:id/config`); empty config defaults to the convention path **`<dataDir>/youtube-cookies.txt`** (in Docker: `~/.nicotind/youtube-cookies.txt` on the host). The flag (`--cookies` for yt-dlp, `--cookie-file` for spotdl) is only passed **when the file actually exists**, so a missing/stale path can never break downloads — drop a Netscape-format cookies export there and the next job picks it up. Export from a logged-in browser (e.g. the "Get cookies.txt" extension); note downloads then run under that Google account.

### Playlists (yt-dlp)

A `watch?v=…&list=…` or `playlist?list=…` URL downloads the whole playlist. Two behaviors make this robust:

- **Partial failures don't sink the job.** yt-dlp runs with `--ignore-errors`, so unavailable/private/deleted videos are skipped instead of aborting at the first one. Crucially, **success is decided by whether audio files landed, not by the exit code** — yt-dlp exits non-zero whenever *any* item failed, even after downloading every other item, so the runner (`acquire/process.ts`) ignores the exit code when `collectAudioPaths` found files and only rejects on `0 files AND non-zero exit`. `AcquireWatcher.run` then marks the job failed only when the resolve produced zero files. A playlist where 40/41 items succeed ingests those 40. Earlier iterations that trusted `--ignore-errors` to yield a zero exit, or that keyed off the exit code, discarded all 40 — the staged files were cleaned up unused.
- **A truncated result still gets flagged, not silently absorbed.** The plugin's return value only carries the paths that landed — not the total the source reported (spotdl logs `Found 16 songs`; that's parsed by `parseSpotdlProgress` and persisted live to `acquire_jobs.progress` via `emitProgress`, same column the in-progress bar reads). Once `resolve()` settles, `AcquireWatcher.run` re-reads that last-known `progress.total` and compares it to `paths.length`: if fewer files landed than were expected, the job still finishes `state: 'done'` (the files that did land are real and worth keeping), but its `error` field carries a human-readable warning (`"Downloaded 1 of 16 tracks — the rest failed or were skipped."`) instead of staying `null`. Found in real use 2026-07-10: a 16-track Spotify album where spotdl only matched 1 track on YouTube read as an unqualified "Done" with no indication anything was wrong. The web's `error` display on `DownloadItemComponent` already renders regardless of stage, so no template change was needed there; `acquireJobToDownloadItem` was updated so `canRetry` also covers `state === 'done' && error` (not just `state === 'failed'`), giving the row a **Retry** button instead of forcing the user to re-paste the link.
- **The job label shows the playlist name.** yt-dlp emits `[download] Downloading playlist: <name>` at the start; `parseYtdlpPlaylistTitle` captures it and the plugin calls `ctx.emitLabel(jobId, name)` → `acquire_jobs.label`, so the Downloads row shows the playlist title instead of the raw URL (the web falls back to a shortened URL when `label` is null). `emitLabel` is part of `PluginHostContext`.
- **Actionable errors.** When a run does fail, the runner stores the captured `ERROR:` lines (the real cause) rather than the last 2 KB of download-progress spam.

### Downloads UI integration

Completed (and in-progress/failed) acquire jobs appear in the **Downloads → Active** tab as a "URL Downloads" section alongside Soulseek transfers — same page, no separate UI. The lifecycle each row shows:

- **Queued / running**: progress bar (files done/total) or indeterminate pulse; cancel (×) button.
- **Done** (`"In Library"`): the files are already in the library. Dismiss (×) removes the job record; the library entry remains.
- **Failed**: truncated error text, **Retry** button (resumes the *same* job id/staging dir rather than starting a new job — see "Resume after truncation" below), Dismiss.

`AcquireJob` shape is exported from `@nicotind/core` so the web package can type-check against it without a cross-package dep on `@nicotind/api`. Done/failed jobs older than 7 days are pruned at startup (`AcquireWatcher` constructor) so the list stays bounded. The Downloads Active tab badge counts both slskd in-progress folders and active acquire jobs.

**Idempotent submit — one URL, one in-flight job.** `AcquireWatcher.submit()` first checks for an existing `queued`/`running` row with the same `url` and returns its id instead of inserting a new one, mirroring the hunt path's "one album = one download" guard. Without this, every re-click of **Get** (or re-paste of a link already in flight — the natural thing to try when a job silently under-delivers, see the partial-download flag above) queued a fresh row with no cap besides the 7-day janitor, so the same URL could accumulate an unbounded number of `acquire_jobs` rows. The guard only dedupes *active* jobs; a URL with a terminal (`done`/`failed`) job still gets a fresh submit via **Get** — **Retry**, by contrast, resumes the existing terminal job's id in place (see "Resume after truncation" above) rather than creating a new row.

#### Unified Active feed (`DownloadItem`)

The Downloads → **Active** tab is one feed, not two sections: slskd album groups and URL acquire jobs both map into a normalized `DownloadItem` (`lib/download-groups.ts` — `groupToDownloadItem` / `acquireJobToDownloadItem`, merged + stage-sorted by `buildDownloadFeed`). Each row (`components/download-item/`) shows the four facets the redesign called for — **how** (method badge from `lib/acquisition-method.ts`), **what stage** (`components/pipeline-stage-badge/`, label/tone from the pure `lib/pipeline-stage.ts`), **when** (started), **where** (storage path, behind a "Where?" toggle) — plus retry / cancel / remove that the component emits and the page dispatches by `item.kind`. slskd method is always `slskd` and its stage derives from the group's transfer state (job-level — organize/scan run as a batch); acquire rows read `method`/`stage`/`storage_path` straight off the job. Rows carry `data-testid="download-item"` + `data-method`/`data-stage` for e2e.

Once a row is complete, it also offers an **"Open in Library"** deep-link to the destination album (`data-testid="download-open-album"`), so "Done" is an action, not a dead end. The target is the deterministic `albumId` the API already ships — `dir.albumJob.albumId` for slskd hunts, `job.albumId` for URL acquires — plumbed through `AlbumGroup` → `DownloadItem` and resolved to `/library/albums/:id` via `resolveAlbumRoute` (`lib/route-utils.ts`). The gating predicate `canOpenInLibrary(item)` (exported from `components/download-item/`, unit-tested since the JIT harness can't render a required `input()`) shows the link only when `stage === 'done'` **and** an `albumId` is present, so direct (non-hunt) slskd downloads — which carry no id — show no link. Because the id is derived from artist/album rather than the scanned tags, a rare divergence just lands on the album-detail page's existing "Album not found → back to library" fallback rather than erroring.

---

## Download list metadata (`AlbumJobMeta`)

`GET /api/downloads` annotates each in-flight folder whose `(username, peer directory)` matches an **active `album_jobs`** row with `albumJob: { artistName, albumTitle, canonicalTrackCount, albumId }` (`enrichWithAlbumJobs` in `routes/downloads.ts`; type in `@nicotind/core`). This lets the Downloads UI show "Artist — Album · N of M tracks" instead of the noisy peer folder name (e.g. "(1995) Toque"). `albumId` is the deterministic `albumIdFor(artistName, albumTitle)` for the destination library album, so a completed download can **deep-link straight to its album page**. The URL-acquire side mirrors this: `AcquireJob` carries `albumId`/`albumArtist`/`albumTitle` derived from the organized `storage_path`'s last two `<Artist>/<Album>` segments via the pure `deriveAcquireAlbum` (`services/acquire-album.ts`; null for loose singles with no album wrapper).

The web groups transfers via the pure `lib/download-groups.ts` (`groupByAlbum`/`albumGroupTitle`/`albumGroupTotal`), which prefers the hunt metadata and falls back to the peer folder name + file count for **direct (non-hunt)** downloads that have no job.

> **Unified acquisition jobs** ([docs/acquisition-jobs.md](acquisition-jobs.md)): every enqueue path now also records an `acquisition_jobs` + `acquisition_job_items` row pair storing the exact `username::filename` transfer keys and the hunt's Lidarr metadata at enqueue time. This is the stored replacement for the string matching described above; the read paths (`enrichWithAlbumJobs`, organizer `jobLookup`) migrate to it phase by phase.

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
