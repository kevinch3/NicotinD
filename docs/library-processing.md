# Windowed library processing (background enrichment)

A single, extensible background processor that fills derived per-track metadata
(BPM, genre — and whatever comes next) for songs that are missing it. It runs
**only inside a configurable daily time window** so the heavy work never competes
with active listening/downloading, and it is **resumable** and **logged**.

## Why

`bpm`/`genre` are only ever *read* from a file's tags at scan time; nothing
derives them. The manual scripts (`scripts/analyze-bpm.ts`,
`scripts/backfill-genre.ts`) can fill the gap but are one-off, never scheduled, and
new downloads regress (they land un-enriched). This subsystem makes enrichment a
continuous, hands-off background process while keeping the download pipeline fast
(transcode + tag + scan stay inline; everything slow is deferred to the window).

## Pieces

| Concern | File |
| --- | --- |
| Shared types | `@nicotind/core` `types/processing.ts` (`ProcessingSettings`, `ProcessingStatus`, `ProcessingTaskId`) |
| Settings store | `services/processing-settings.ts` (`app_settings` key `processing`) |
| Pure window math | `services/processing-window.ts` (`isWithinWindow`, midnight-crossing) |
| Task registry | `services/enrichment/tasks.ts` (`ENRICHMENT_TASKS`) |
| Scheduler | `services/library-processing.service.ts` (`LibraryProcessingService`) |
| Admin routes | `routes/admin.ts` (`/api/admin/processing*`) |
| Web panel | `pages/settings/` + DI-free `lib/processing-progress.ts` |

## The task registry — the extension point

Each enrichment task implements `EnrichmentTask`:

```ts
interface EnrichmentTask {
  id: ProcessingTaskId;
  label: string;
  available(ctx): true | string;   // true, or a human reason it can't run
  countPending(db): number;        // COUNT(*) of the NULL-predicate — drives resume + progress
  run(db, ctx, limit): Promise<{
    applied: number;
    labels: string[];
    failed: number;                // items attempted (file present, work needed) but errored
    errorSample: string | null;    // one representative reason (ffmpeg stderr tail / sidecar error)
  }>;
}
```

The `analyzeBpm` / `analyzeKey` / `analyzeLoudness` primitives on `EnrichmentContext`
take an optional `onError(err)` callback; a decode failure fires it (returning null),
which the worker folds into `failed`/`errorSample`. A quiet null (e.g. audio too short
to lock a tempo) is **not** a failure. The audio-features task distinguishes a per-file
sidecar rejection (counted) from a whole-sidecar outage (not counted — songs just stay
pending).

Launch tasks:

- **bpm** — `WHERE bpm IS NULL`, available only when `ffmpegAvailable()`. Reads a
  tag BPM if present, else `analyzeBpm()` (ffmpeg decode → `music-tempo`). Runs a
  bounded worker pool (`settings.concurrency`). Writes `library_songs.bpm` and the
  file tag (analyzed values only).
- **genre** — `WHERE genre IS NULL OR genre = ''`, available only with Lidarr. Uses
  `planGenreBackfill` so an artist is looked up **once** and fanned out to all their
  pending songs. Writes `library_songs.genre` and the file tag. Songs whose artist
  Lidarr can't resolve are `recordAnalysisFailure`d (not tallied — see the exclusion
  section below) so they drop out of the pending set after the attempt cap instead of
  being re-queried every batch forever.
- **key** — `WHERE key IS NULL OR key = ''`, ffmpeg-gated, **offline**. Reads a tag
  key if present, else `analyzeKey()` → the pure Krumhansl–Schmuckler estimator in
  `services/key-detection.ts` (chromagram via per-semitone Goertzel filters → KS
  major/minor profile correlation → key + Camelot code). Writes `library_songs.key`
  (e.g. "C major") and the file tag (ID3 `TKEY` / Vorbis `KEY`). Bulk script:
  `scripts/analyze-key.ts`.
- **energy** — `WHERE energy IS NULL`, ffmpeg-gated, **offline**. Reads an
  `ENERGY` tag if present, else `analyzeLoudness()` (`loudness-analysis.ts`:
  ffmpeg `ebur128` → integrated LUFS + loudness range → derived 0..1 energy).
  Writes `library_songs.energy` + `loudness` and the `ENERGY`/`LOUDNESS_LUFS`
  file tags. Bulk script: `scripts/analyze-energy.ts`.
- **audio-features** — `WHERE danceability IS NULL`, gated on the **analysis
  sidecar** (`packages/analysis/`, configured via `NICOTIND_ANALYSIS_URL` /
  `analysis.url`; availability = live cached health probe, so the Settings row
  shows "not configured" vs "unreachable"). Tag-first: a file already carrying
  all five feature tags is adopted without a sidecar call. Otherwise `POST
  /analyze {relPath}` returns danceability/valence/acousticness/instrumental/
  mood + the EffNet embedding; the task writes the five columns + a
  `library_embeddings` row in one transaction, then the file tags. Concurrency
  is capped at 2 (the sidecar serializes inference). A sidecar loss mid-batch
  aborts the batch; songs stay pending. A **422** (un-decodable file) throws
  `AudioFileRejectedError` → ledgered + tallied so corrupt files auto-skip after
  `MAX_ANALYSIS_ATTEMPTS` (mirrors bpm/key/energy); a 404/503 stays `null` and
  un-ledgered (environmental — see the exclusion section below). Bulk script:
  `scripts/analyze-audio-features.ts`. See
  [audio-ml-enrichment.md](audio-ml-enrichment.md).
- **artist-image** — per *artist*, not per song: artists with no
  `library_artwork(kind='artist')` row, `manual_override = 0`, `hidden = 0`, and a
  non-placeholder name (`isPlaceholderArtist`), most-prolific first (`album_count DESC`).
  Available with **Lidarr or Spotify** configured. Resolves a real portrait via
  `resolveArtistImageUrl` (Lidarr poster → Spotify fallback, one `artist.list()` per
  batch), writes the `library_artwork` URL via `setArtwork`, and evicts the cover
  route's negative-cache (`clearCoverNegativeCache`) so the portrait shows at once. It
  never touches a manually-overridden artist. The auto path for the artist grid — see
  [library-scanner.md](library-scanner.md) "Artist images" and
  [spotify-fallback.md](spotify-fallback.md). Its context carries `coverCacheDir` +
  `lookupArtistImageSpotify` (the Spotify portrait lookup, null when unconfigured).

### Durability vs. the periodic full scan

The scanner runs frequent full scans. A plain `col = excluded.col` upsert would
revert any **DB-only** enrichment to the (tag-less) file value before the task's
slower/failable file-tag write lands. So `genre`, `bpm`, `key`, and all seven
perceptual columns (`energy`, `loudness`, `danceability`, `valence`,
`acousticness`, `instrumental`, `mood`) are written
`COALESCE(excluded.col, library_songs.col)` in `library-scanner.ts`: a file tag that
*carries* the value still overrides, but a tag-less rescan keeps the enrichment.
This is why a backfill that writes only the DB (e.g. a script killed mid-run before
its tag writes) reverts, while the windowed task — which completes tag+DB per song —
sticks.

All IO-heavy primitives come from the injected `EnrichmentContext`
(`ffmpegAvailable`, `readTags`, `writeTags`, `analyzeBpm`, `lookupGenre`,
`fileExists`), so tasks are unit-tested with fakes — no real ffmpeg/Lidarr.

### Adding a future task (e.g. mood)

1. Add the storage column + scan-time read (mirror `bpm`).
2. Add the id to `ProcessingTaskId` (and the web `core` shim).
3. Append one `EnrichmentTask` to `ENRICHMENT_TASKS` with its NULL-predicate
   `countPending`, an `available` gate, and a `run` that reuses a primitive on
   `EnrichmentContext` (extend the context if it needs a new one).

The scheduler, settings, status, SSE, and UI pick it up generically (the per-task
checkbox renders from `settings.tasks`/`status.availability`).

## Scheduler behaviour

Modeled on `WatchlistService` (interval + a `busy` guard so runs never overlap):

- **`tick()`** (periodic, default 60 s): no-op when disabled (`phase: disabled`) or
  outside the window (`phase: outside-window`); otherwise runs **one bounded batch
  per runnable task**. The short interval + guard make in-window work effectively
  continuous and re-evaluate the window at each batch boundary, so processing stops
  promptly when the window closes.
- **`runNow()`** (admin "Run now"): drains batches in a loop **ignoring** the
  window, until nothing is pending or a batch makes no progress.
- **`cancelRun()`** (admin "Stop"): aborts the current run between tasks/batches
  **without** disabling the scheduler. The cancellation token is reset at the start
  of every run.
- **`stop()`**: full shutdown (clears the interval + aborts). Wired into SIGTERM/SIGINT.

### Failure diagnosis, feedback & Sentry

Both ffmpeg call sites (`track-analysis.ts` `decodePcm`, `loudness-analysis.ts`
`analyzeLoudness`) **capture stderr** and fold its tail into the thrown/logged error
via `summarizeFfmpegStderr`, so a decode failure reports *why* (e.g. "Invalid data found
when processing input") instead of a bare "exited with code 183". why: a real bug where
every decode failed opaquely and the reason was thrown away.

Each run tallies `failed`/`lastError` into `ProcessingStatus` (persisted + streamed over
SSE). At a run boundary the scheduler calls `flushFailures`, emitting **one aggregated
event per failing task** through an injectable `reportFailure` sink — defaulting to
`captureProcessingFailure` (`observability/sentry.ts`), which is a no-op when Sentry is
unconfigured and uses a task+sample `fingerprint` so a broken decoder collapses into a
single Sentry issue rather than one event per file. `runNow` reports once for the whole
drain; `tick` once per batch.

A "run" for the tally spans one **window session**: tick batches inside the same window
continue accumulating `processed`/`failed`/`lastError`; the first batch after the phase
was `outside-window`/`disabled` (or an explicit `runNow`, or a **process restart**)
resets them. why: the tally is persisted + reloaded across restarts, so without a
session boundary a long-resolved failure banner ("38 failed — ffmpeg …") stayed on the
panel forever, even after the offending files were excluded by the ledger below. The
restart boundary exists because a restored tally belongs to the *previous* process — a
mid-window deploy once carried 2,300 pre-fix sidecar failures into a perfectly healthy
run's display. The restored counts remain visible until the new process's first batch
(so the panel still shows last-known state after a reboot), then reset.

`processOneBatch` leaves the phase `running` between batches; a run's terminal `idle` is
set exactly once by `finishRun`, so an SSE client sees a single `running → idle`
completion (not one per batch). The Settings panel uses that transition to toast the
outcome (see Web).

### Corrupt/undetectable-file exclusion (stop retrying files that can't yield a result)

Without this, a permanently-broken file (e.g. a truncated download that ffmpeg rejects
with "Invalid data") stays `NULL` forever, so it's re-attempted — and re-alerted — on
*every* run. `enrichment/analysis-failures.ts` + the `library_song_analysis_failures`
table (keyed `(song_id, task)`) fix that:

- On a hard per-item failure the worker calls `noteItemFailure`, which both tallies the
  run and `recordAnalysisFailure`s it (incrementing `fail_count`, storing the file `size`
  + a truncated reason).
- **Undetectable results are ledgered too, but not tallied.** `analyzeBpm`/`analyzeKey`
  signal a deterministic "analysis ran, found nothing" outcome (signal too short/quiet to
  lock a tempo, no tonal content) via `NoConfidentResultError` on the `onError` callback.
  `noteItemFailure` records those in the ledger — otherwise the same undetectable files
  head the `created DESC` selection and are re-decoded every batch forever, starving
  everything queued behind them (in prod this wedged the bpm task on ~95 files and kept
  the corrupt ones from ever reaching the ledger) — but does **not** count them as run
  failures: nothing is broken, so they must not trip the panel banner or Sentry.
  Environmental nulls (music-tempo module unavailable) deliberately stay un-ledgered so
  files remain pending until the environment is fixed.
- Once `fail_count` reaches `MAX_ANALYSIS_ATTEMPTS` (3), the task's `countPending`/`run`
  SELECTs exclude the file via `notPermanentlyFailedClause` (a bare correlated
  `NOT EXISTS`, threshold + task inlined so it drops into an existing `LIMIT ?` without
  new params). So `total`/"remaining" comes to mean *analyzable* remaining.
- **Reset is content-based**: the clause matches on `file_size IS library_songs.size`, so
  a re-download (which changes the size) re-includes the file automatically. A *success*
  calls `clearAnalysisFailure` to wipe the row outright.
- **Scope now covers the decode + metadata-resolution tasks**, each
  provenance-aware so environmental outages never get ledgered:
  - `bpm`/`key`/`energy`: an ffmpeg *decode* failure reliably means the *file*
    is bad (corrupt / truncated) — ledgered + tallied as run failures.
  - `audio-features`: the sidecar throws `AudioFileRejectedError` on HTTP **422**
    (it reached + tried to decode the file but the bytes are unusable —
    "Invalid data" / "decoded audio too short"). That's a per-file condition
    mirroring the decode tasks, so it's ledgered + tallied. A **404** (file not
    visible to the sidecar — usually a `MUSIC_DIR` mount mismatch that 404s
    *every* file) and a **503** (models not loaded) stay `null` and are **not**
    ledgered: those are environmental, and permanently skipping on them would
    leave the whole library excluded even after the sidecar is fixed. This was
    the prod stall: ~32 sub-10 KB junk/AppleDouble files 422'd every run, the
    task had no ledger so they stayed pending forever, tripping `runNow`'s
    `applied === 0` early-exit after one batch.
  - `genre`: a song whose artist Lidarr can't resolve is ledgered (so it stops
    being re-queried every batch — a real prod backlog of ~1100 songs across
    ~150 Lidarr-unknown artists starved the queue) but **not** tallied as a
    failure: nothing is broken, Lidarr simply has no genre. A re-tag/re-download
    changes the size and re-includes it.
- `artist-image` (per-artist; failures there are metadata-service issues, not
  audio-file problems) is **not** ledgered.
- `countSkippedFiles` (distinct files at the cap) surfaces as `ProcessingStatus.skipped`,
  shown in the panel as "N files skipped: unreadable or not analyzable (re-download to
  retry)".

### Runtime hardening — ffmpeg timeouts

Each ffmpeg decode is spawned with a wall-clock **kill timer** (`DECODE_TIMEOUT_MS` 120s
for the bpm/key head-slice; `EBUR128_TIMEOUT_MS` 180s for the full-file energy pass). A
90 s slice decodes far faster than realtime, so the timer only trips on a hung/pathological
file — where it `SIGKILL`s ffmpeg and surfaces a "timed out" error (counted like any other
failure, so it feeds the exclusion ledger). Without this, one file that makes ffmpeg hang
would leave a worker's `Promise` unresolved, wedging the whole run (and the `busy` guard)
indefinitely.

### Resume & logging

Resume is inherent: each task selects by its `… IS NULL` predicate and writes
incrementally, so an interrupt/restart simply continues with whatever is still
pending. Run progress (`processed`/`total`/`lastItems`/`phase`) is persisted to
`app_settings.processing_status` so the UI shows last counts after a restart. Every
enriched item is appended to `<dataDir>/library-processing.log`
(`<iso>\t<task>\t<label>`) and emitted as a `ProcessingStatus` snapshot on the
service's `'status'` EventEmitter (the SSE source).

## Admin API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/admin/processing` | `{ settings, status }` (status has per-task pending counts + availability reasons) |
| PUT | `/api/admin/processing` | Update settings (validates `HH:MM` window + positive `batchSize`/`concurrency`) |
| POST | `/api/admin/processing/run` | `runNow()` (ignore window) |
| POST | `/api/admin/processing/stop` | `cancelRun()` |
| GET | `/api/admin/processing/stream` | SSE status snapshots (progress bar + snippets) |

All admin-only; `503` when the service isn't wired.

## Web

Admin-only **Library processing** panel in Settings (`data-testid="processing-panel"`):
enable toggle, window `<input type="time">`s, per-task checkboxes (greyed with the
availability reason when ffmpeg/Lidarr is missing), a progress bar + live snippet
list driven by an `EventSource` on the stream endpoint, and Run now / Stop. Percent
and phase-label math is the DI-free, unit-tested `lib/processing-progress.ts`.

**Feedback (this change):** "Run now" is disabled while a run is starting or in progress
(`runNowDisabled()`, label flips to "Running…"); "Stop" is disabled unless a run is
active. A failure count + reason renders in the progress area (`data-testid="processing-failed"`).
When a *user-initiated* run settles, the panel toasts the outcome via `ToastService`
(error with the reason if any item failed, success otherwise) — gated on having seen a
`running` frame so background/window runs and the priming frame stay silent. The pure
`runOutcomeToast` / `isRunning` helpers in `lib/processing-progress.ts` carry that logic
and are unit-tested.

## One-time prod backfill

For an existing library, run the manual scripts inside the container once to fill
the backlog quickly (the window then keeps up with new downloads):

```bash
docker exec <container> bun run packages/api/src/scripts/backfill-genre.ts --apply       # fast, needs Lidarr
docker exec -d <container> bun run packages/api/src/scripts/analyze-bpm.ts --apply --concurrency 4   # slow, offline
docker exec -d <container> bun run packages/api/src/scripts/analyze-key.ts --apply --concurrency 4   # slow, offline
docker exec -d <container> bun run packages/api/src/scripts/analyze-energy.ts --apply --concurrency 4  # slow, offline
docker exec -d <container> bun run packages/api/src/scripts/analyze-audio-features.ts --apply          # needs the analysis sidecar up
```

All are dry-run without `--apply` and resume on re-run. **Run them sequentially**, not
concurrently — multiple writer processes plus the app fight over the SQLite write
lock. Prefer the in-process windowed processor (or admin **Run now**) over scripts:
it shares the app's connection (no lock contention) and completes tag+DB per song so
nothing reverts on the next full scan.
