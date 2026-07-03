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
  run(db, ctx, limit): Promise<{ applied: number; labels: string[] }>;
}
```

Launch tasks:

- **bpm** — `WHERE bpm IS NULL`, available only when `ffmpegAvailable()`. Reads a
  tag BPM if present, else `analyzeBpm()` (ffmpeg decode → `music-tempo`). Runs a
  bounded worker pool (`settings.concurrency`). Writes `library_songs.bpm` and the
  file tag (analyzed values only).
- **genre** — `WHERE genre IS NULL OR genre = ''`, available only with Lidarr. Uses
  `planGenreBackfill` so an artist is looked up **once** and fanned out to all their
  pending songs. Writes `library_songs.genre` and the file tag.
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
  aborts the batch; songs stay pending. Bulk script:
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
