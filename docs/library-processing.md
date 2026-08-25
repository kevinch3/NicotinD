# Library processing (background enrichment)

A single, extensible background processor that fills derived per-track metadata
(BPM, genre — and whatever comes next) for songs that are missing it. It runs
continuously while enabled, and it is **resumable** and **logged**.

> **Removed:** this used to run only inside a configurable daily window, and to
> expose a "compute regulator" (concurrency, batch size, and a yield-above-N%-GPU
> threshold). Both are gone. The window was a no-op in practice — the reference
> deployment ran a 23 h 45 m window — and issue #224's own measurement found the
> GPU yield changed neither throughput nor GPU memory. `concurrency` and
> `batchSize` are now the constants `PROCESSING_CONCURRENCY` /
> `PROCESSING_BATCH_SIZE` in `library-processing.service.ts`. Standing down for
> another tenant on the card is `paused`'s job.

## Why

`bpm`/`genre` are only ever *read* from a file's tags at scan time; nothing
derives them. The manual scripts (`scripts/analyze-bpm.ts`,
`scripts/backfill-genre.ts`) can fill the gap but are one-off, never scheduled, and
new downloads regress (they land un-enriched). This subsystem makes enrichment a
continuous, hands-off background process while keeping the download pipeline fast
(transcode + tag + scan stay inline; everything slow is deferred to the background).

## Pieces

| Concern | File |
| --- | --- |
| Shared types | `@nicotind/core` `types/processing.ts` (`ProcessingSettings`, `ProcessingStatus`, `ProcessingTaskId`) |
| Settings store | `services/processing-settings.ts` (`app_settings` key `processing`) |
| Task registry | `services/enrichment/tasks.ts` (`ENRICHMENT_TASKS`) |
| Scheduler + landing gate | `services/library-processing.service.ts` (`LibraryProcessingService`) |
| Per-track step state | `services/song-steps.ts` (`loadQuarantineQueue`, `computeSongSteps`) |
| Admin routes | `routes/admin.ts` (`/api/admin/processing*`, incl. `/processing/queue`) |
| Web panel | `pages/admin/` (`AdminComponent`) + DI-free `lib/processing-progress.ts` |

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
  tag BPM if present, else detects one **sidecar-first**: `ctx.analyzeRhythm`
  (the analysis sidecar's `POST /rhythm`, Essentia RhythmExtractor2013) when a
  sidecar is configured, falling back to `analyzeBpm()` (ffmpeg decode →
  `music-tempo`) when it isn't or is unreachable. Why: music-tempo makes
  frequent octave errors — it locks onto half- or double-tempo beat agents (a
  prod sample showed ~50% of stored BPMs off by 2× in *both* directions, e.g.
  AC/DC "Shoot to Thrill" stored 73 vs real ~141, ska tracks stored 175–182 vs
  real ~88), and the errors go both ways so no one-direction heuristic can
  repair them locally. A sidecar 422 (un-decodable file) is ledgered without
  attempting the local fallback (same bytes would fail again); a transport
  error falls back. Runs a bounded worker pool (`settings.concurrency`).
  Writes `library_songs.bpm` and the file tag (analyzed values only). Repairing
  historical octave errors: `scripts/analyze-bpm.ts --recheck` (below).
- **genre** — `WHERE genre IS NULL OR genre = ''`, available only with Lidarr. Uses
  `planGenreBackfill` so an artist is looked up **once** and fanned out to all their
  pending songs. Writes the **full Lidarr genre list** (best-first) by **appending**,
  not replacing: `appendSongGenres` unions Lidarr's set into whatever the song already
  has (existing first, so the current primary is preserved; case-insensitive dedup),
  writing the merged set to `library_song_genres` + the mirrored `library_songs.genre`
  primary and the `"; "`-joined merged list to the file tag. The pending filter is
  still empty-genre songs, so in practice this appends onto nothing — but the union is
  the invariant everywhere genre is detected (see below), and means a genre step never
  clobbers tag genres. Songs whose artist Lidarr can't resolve are
  `recordAnalysisFailure`d (not tallied — see the exclusion section below) so they drop
  out of the pending set after the attempt cap instead of being re-queried every batch
  forever.

  Genre detection **always appends** (`appendSongGenres`), never overrides: the
  track-info sheet's "detect genre" apply (`POST /api/library/songs/:id/genre`), this
  task, and the on-demand `scripts/append-genre-backfill.ts` (dry-run unless `--apply`,
  optional `--limit`; runs over the **whole** library, not just empty-genre songs, and
  is idempotent via the dedup) all add rather than replace. Distinct from
  `backfill-genre.ts`, which only *fills* empty-genre songs and *replaces* their set.
  A curator **removing or reordering** a chip in that sheet is the one path from the UI
  that sends `mode: 'replace'` — "exactly this set, in this order" is only expressible
  as a song-scoped override (issue #684, see [web-ui.md](web-ui.md)).
- **key** — `WHERE key IS NULL OR key = ''`, ffmpeg-gated, **offline**. Reads a tag
  key if present, else `analyzeKey()` → the pure Krumhansl–Schmuckler estimator in
  `services/key-detection.ts` (chromagram via per-semitone Goertzel filters → KS
  major/minor profile correlation → key + Camelot code). Writes `library_songs.key`
  (e.g. "C major") and the file tag (ID3 `TKEY` / Vorbis `KEY`). Bulk script:
  `scripts/analyze-key.ts`. **Confidence-gated** (issue #187 task B5):
  `chromaToKey` always picks *some* key for any non-flat chroma — even white
  noise correlates ~0.5–0.6 with one of the 24 profile rotations — so a raw
  non-null result isn't reliable on its own. `isConfidentKey`
  (`key-detection.ts`, floor `MIN_KEY_CONFIDENCE = 0.5`, measured against 60
  real library tracks: ~33% self-consistency below the floor, climbing past
  70–90% above it) gates the result; below it, `analyzeKey` ledgers via
  `NoConfidentResultError` exactly like "too short"/"no tonal content" — same
  ledgered-not-tallied treatment, so an unreliable detection drops out of the
  pending set instead of writing a confidently-wrong key.
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
- **descriptors** (issue #641) — songs with no usable current-version row in
  `library_song_descriptors` (`descriptorsPendingClause`: no row, an older
  `DESCRIPTOR_VERSION`, or a stale `file_size`), gated on the sidecar's
  **`/health.descriptors` flag** rather than its model status — `POST
  /descriptors` needs no model files, so a models-less build still serves it.
  Stores the 40 raw timbre/groove/band values as one JSON row; not
  tag-mirrored, **never a landing gate** (~5 s CPU per track), concurrency
  capped at 2, same 422-ledgered / 404-503-pending contract as audio-features.
  Bulk script: `scripts/backfill-descriptors.ts` (runs the same task body). See
  [audio-descriptors.md](audio-descriptors.md).
- **genre-audio** (issue #187 task A2, an audio-inferred genre fallback) —
  `WHERE (genre IS NULL OR genre = '') AND EXISTS (... task = 'genre')`, gated
  on the analysis sidecar like `audio-features` (and reuses its
  `ctx.analyzeAudioFeatures` call — the `genre_discogs400` head rides along on
  the same `/analyze` response). The `EXISTS` clause is load-bearing: it only
  fires once `genre` has already tried and ledgered the song as unresolved —
  without it, an audio-only guess could win a race against the authoritative
  Lidarr/MusicBrainz source for a song `genre` simply hasn't reached yet
  (writing a genre clears `library_songs.genre`, permanently removing the
  song from `genre`'s pending set). A Lidarr-less install never populates that
  ledger, so `genre-audio` never fires there — an accepted limitation, since
  this is a fallback, never a primary source. A confidence below
  `NICOTIND_GENRE_AUDIO_CONFIDENCE` (default 0.5) is ledgered via
  `NoConfidentResultError` (not tallied — the classifier ran and found
  nothing confident, mirroring an unresolvable genre); a build without
  the head (`genre: null`) is treated the same way. A confident hit is
  written via the provenance-tagged `library_genre_overrides` path
  (`source: 'essentia'`, scope `song`) — never `appendSongGenres` — so it can
  never overwrite a `user` override and combines non-destructively with any
  existing tag genres. **Never a landing gate** (no `satisfiedColumnSql`): a
  weak classifier must never strand a fresh download. See
  [audio-ml-enrichment.md](audio-ml-enrichment.md) and
  [library-scanner.md](library-scanner.md) "Multi-genre support".
- **genre-discogs** (issue #194, the #187 A1 _second_ provider) — album-scoped,
  same `EXISTS (... task = 'genre')` gate as `genre-audio` (runs over what the
  Lidarr `genre` task left behind). Groups the pending songs **by album** and
  runs one `ctx.lookupGenreForRelease` (the Discogs `genre` capability) per album
  — release-scoped because #187 measured album coverage at ~67% vs artist ~3%, so
  it can't ride the artist-scoped `genre` fan-out. A confident match
  (`confidence ≥ 0.8`) is written `library_genre_overrides` (`source='discogs'`,
  scope `album`, `status='applied'`) **and applied inline** so genres appear
  without a rescan; a lower one is `status='pending'` for curator review.
  Re-query is prevented by the override-existence skip + the per-song ledger; a
  lookup that **throws** (provider outage) is separated from a confident miss
  (`erroredAlbums` in `planDiscogsAlbumGenres`) and left unledgered so it retries.
  **Never a landing gate**, and **off by default** (`tasks['genre-discogs'] =
  false`) since it needs the consent-gated Discogs extension. Discogs' comma/slash
  top-level vocab is mapped separator-free (`discogs-genre-vocab.ts`) before it
  reaches `splitGenres`. See [discogs-plugin.md](discogs-plugin.md) "Genre
  enrichment".
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
- **artist-info** — per *artist*: artists with no `library_artist_meta` row,
  `hidden = 0`, most-prolific first (`album_count DESC`). Available when an
  artist-info-capable plugin is configured (currently Discogs). Resolves artist bios +
  external links via MBID-first lookup (`getMbid` for a cached MusicBrainz id →
  `ctx.lookupArtistInfo(mbid)`), writes the result to `library_artist_meta` via
  `upsertArtistMeta`, or writes a tombstone (bio=NULL, urls=[]) on no MBID / no result.
  Skips `manual_override = 1` rows entirely (writes never run; pending predicate excludes
  them). **Never a landing gate** (optional enrichment, no `satisfiedColumnSql`). See
  [library-scanner.md](library-scanner.md) "Artist bios".

- **artist-identity** — per *compound artist string*, not per song. Resolves whether a
  delimited artist like "Bob Marley & The Wailers" (one act) vs "Bob Marley, Peter Tosh"
  (two artists) should be split, and caches the decision in `library_artist_identity` so
  the **synchronous scanner** can split with zero network calls (see
  [library-scanner.md](library-scanner.md) "Multi-artist support"). Pending = distinct
  delimited `artist`/`album_artist` strings lacking a fresh (7-day TTL) authority row.
  Available with **Lidarr** configured (`ctx.resolveArtistIdentity`, a memoized
  `artist.lookup` wrapper). Per compound it records `single` (the whole string is a
  canonical artist → keep whole), `split` (every part resolves to a real artist →
  members feed the confirmed set), or `unknown` (Lidarr has no confident opinion —
  recorded anyway so it drops out of the pending set until the TTL lapses; the scanner's
  library-atomic confirmation then decides). Like `artist-image` it's per-artist, so it
  has **no `satisfiedColumnSql`** and is never a landing gate. One-shot seed:
  `scripts/resolve-artist-identity.ts` (dry-run default, `--apply`).

- **popularity** (issue #220) — `WHERE popularity IS NULL`, always available (ListenBrainz
  needs no credentials). The first *extrinsic* signal: it reads each pending song's
  `mbRecordingId` tag, **batches** all the MBIDs into one `ctx.lookupPopularity`
  (`ListenBrainzClient` → `POST /1/popularity/recording`), and writes a log-normalized 0–1
  `library_songs.popularity` + `popularity_source='listenbrainz'`. Three misses are distinct:
  no-MBID-tag and LB-confirmed-no-data are confident misses ledgered-not-tallied
  (`NoConfidentResultError`); a transient 429/outage (the MBID absent from the response map)
  is **not** ledgered so it retries. **Not tag-mirrored** (extrinsic + drifts), so the scanner
  omits it from its upsert entirely and it survives rescans without a COALESCE. Default-on,
  **never a landing gate**. Full detail in [popularity.md](popularity.md).

### Durability vs. the periodic full scan

The scanner runs frequent full scans. A plain `col = excluded.col` upsert would
revert any **DB-only** enrichment to the (tag-less) file value before the task's
slower/failable file-tag write lands. So `genre`, `bpm`, `key`, and all seven
perceptual columns (`energy`, `loudness`, `danceability`, `valence`,
`acousticness`, `instrumental`, `mood`) are written
`COALESCE(excluded.col, library_songs.col)` in `library-scanner.ts`: a file tag that
*carries* the value still overrides, but a tag-less rescan keeps the enrichment.
This is why a backfill that writes only the DB (e.g. a script killed mid-run before
its tag writes) reverts, while the background task — which completes tag+DB per song —
sticks.

All IO-heavy primitives come from the injected `EnrichmentContext`
(`ffmpegAvailable`, `readTags`, `writeTags`, `analyzeBpm`, `lookupGenre`,
`fileExists`), so tasks are unit-tested with fakes — no real ffmpeg/Lidarr.

### Not for operator-triggered whole-library passes

`ENRICHMENT_TASKS` is for *unattended, per-song* enrichment. Destructive library-wide passes an
admin starts and watches — metadata-optimize, the Opus standardization, a full rescan — live on the
separate `MaintenanceService` registry (`services/maintenance/`, issue #622), which mirrors this
one's vocabulary deliberately. `runNow()` here drains **every** runnable task and this scheduler
runs in the background, so putting them here would both over-trigger and auto-run them; see
[metadata-optimize.md](metadata-optimize.md) "Running it in the background" for the full four-reason
rationale.

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
  paused (`phase: paused`, see below); otherwise runs **one bounded batch per
  runnable task**. The short interval + guard make the work effectively continuous.
- **`runNow()`** (admin "Run now"): drains batches in a loop, overriding `paused`,
  until nothing is pending or a batch makes no progress.
- **`cancelRun()`** (admin "Stop"): aborts the current run between tasks/batches
  **without** disabling the scheduler. The cancellation token is reset at the start
  of every run.
- **`stop()`**: full shutdown (clears the interval + aborts). Wired into SIGTERM/SIGINT.
- **`kickEager()`** (eager, out-of-band): drains **only the required gate tasks**
  for quarantined songs then graduates — see the landing gate below.

## Landing gate (process-before-landing)

A freshly-downloaded song is written to `library_songs` by the scanner (so the
enrichment tasks can operate on it) but starts **quarantined**: `landed_at IS NULL`,
hidden from *every* library listing (see `docs/download-pipeline.md` for the listing
coverage). It **graduates** (a `landed_at` timestamp is set) only once its required
processing steps are done. This inverts the old flow where a download appeared
instantly, un-enriched.

- **`landed_at`** (`library_songs`, `db.ts`): NULL = quarantined, timestamp = landed.
  The scanner deliberately never writes it (omitted from `persist()`'s INSERT and
  UPDATE), so a fresh scan mints NULL and a rescan preserves the value. The
  processing service is the **only** writer that sets a timestamp. A one-time
  marker-gated backfill (`library_sync_state` key `landing_backfill_v1`) lands every
  pre-existing row so an upgrade never retroactively hides music.
- **Per-task gate flag** (`ProcessingSettings.gates`, a sparse
  `Partial<Record<ProcessingTaskId, boolean>>`, deep-merged like `tasks`): distinct
  from `tasks` (background enable). Defaults: `bpm`/`key`/`energy`/`genre` gated;
  `audio-features` (sidecar, off on fresh installs) and per-artist `artist-image`
  are **not** gates. Admin toggles both flags per task (Admin → Library processing).
- **`requiredGateTasks(settings)`** = tasks that are `gates[id]` **AND** `tasks[id]`
  **AND** `available(ctx)===true` **AND** have a `satisfiedColumnSql`. The
  availability intersection is the **fresh-install / sidecar-off guarantee**: an
  off/unavailable gated task is silently dropped from the required set, so a missing
  tool, absent Lidarr, or a dark sidecar can never strand a download. An empty
  required set means nothing gates landing (the pre-feature behaviour).
- **`satisfiedColumnSql`** (per `EnrichmentTask`): the inverse of its `countPending`
  NULL predicate (`bpm IS NOT NULL`, `danceability IS NOT NULL`, …). `artist-image`
  has none → never a landing gate.
- **One definition of "owned"** (issue #692). Quarantine hides a song from listings,
  so nothing may report it as owned either. `DiscographyService.fetchLocalSongs`
  counts only landed songs and `fetchLocalAlbums` only albums with at least one
  landed song — otherwise the two halves of the artist page contradicted each other:
  "0 albums" in the header beside "10/10 tracks · 1 complete" in the discography
  strip, for an album every album surface was deliberately hiding (#687). A partly
  landed album now reads *partial*, which is the honest answer — those are the
  tracks that exist for the user right now. Whole-library maintenance readers
  (`library-audit`, `artwork-backfill`, `library-retag`) deliberately still see
  quarantined rows: they operate on what is on disk, not on what the user owns.
- **`graduatePending(settings)`** runs at the end of every batch (`processOneBatch`)
  and inside `kickEager`. It lands songs where every required step is `satisfied OR
  permanentlyFailed` (the ledger complement `permanentlyFailedClause`, so a corrupt
  file the enrichment can never analyze still lands), **OR** the song has been
  quarantined longer than `QUARANTINE_MAX_HOURS` (24h). That **safety valve** is the
  key correctness guard: it covers the deliberately un-ledgered failure modes
  (sidecar 404/503 mount mismatch, an env-level decode outage) that would otherwise
  hold a download invisible forever.
- **Eager processing**: `scanIncremental` (`index.ts`) fires a fire-and-forget
  `processingRef.current?.kickEager()` after every organize+scan, so a new download's
  gate steps run **immediately**, and it lands as soon as it's
  ready. `tick()` also runs a gate-only pass whenever a quarantined
  song exists, backstopping a missed kick (crash between scan and kick, restart
  mid-quarantine). This is separate from full/background enrichment of the
  existing library.
- **`ProcessingStatus.quarantined`** counts songs awaiting their gate steps;
  `GET /api/admin/processing/queue` (`song-steps.ts` `loadQuarantineQueue`) returns
  them grouped by album with per-step badges (`done`/`pending`/`skipped`).
- **Boot backlog**: `runSyncAndCurate` fires `kickEager()` after the initial
  `scanFull`, and `tick()` runs a gate-only pass whenever a quarantined song exists,
  so a restart processes any quarantined backlog immediately.
- **A deep link into quarantine says so** (issue #466): the quarantine hold is
  invisible to every listing, but `GET /api/library/albums/:id` is reachable by
  *link* — and the Downloads card offers "Open in Library" the moment the
  **download** completes, which is precisely the start of the quarantine window.
  Both that hold and a genuinely absent album used to answer a bare
  `{ error: 'Album not found' }`, so a user who clicked the button on their
  brand-new album was told it did not exist. The status stays **404** (it really
  isn't in the library yet — the grid agrees), but the response now carries a
  `code`: `ALBUM_PROCESSING` vs `ALBUM_NOT_FOUND`, following the #337 typed-code
  convention. The web client classifies it with the pure
  `lib/album-load-state.ts` `albumLoadFailureFor` into `processing` / `missing` /
  `unavailable` and renders a distinct state for each — the album page previously
  `catch { /* ignore */ }`-ed **every** failure (500, 401, offline included) into
  the same "Album not found.", which is why a server error and a processing
  album were indistinguishable. Prod measurement that motivated this: quarantine
  lasts ≤1 min for 4,989 of 14,974 songs but **>24 h for 7,195** (mean ~14 h), so
  this is the common path, not an edge case.
- **Escape hatch**: `NICOTIND_DISABLE_LANDING_GATE=1` bypasses the gate entirely
  (`requiredGateTasks` returns `[]` → everything lands immediately). The e2e harness
  sets it because its silent-FLAC fixtures can't yield a confident BPM/key and would
  otherwise stay quarantined behind analysis that never completes.

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

A "run" for the tally spans one **continuous drain**: consecutive batches that still
find work continue accumulating `processed`/`failed`/`lastError`; the first batch that
finds work *after the queue ran dry* — or an explicit `runNow`, a `disabled` phase, or a
**process restart** — resets them. why: the tally is persisted + reloaded across
restarts, so without a session boundary a long-resolved failure banner ("38 failed —
ffmpeg …") stayed on the panel forever, even after the offending files were excluded by
the ledger below.

The drain boundary (`drained` in `LibraryProcessingService`) replaced a **window
session** when the processing window was removed. `phase === 'idle'` cannot stand in
for it: `finishRun()` sets `idle` after *every* batch. And a batch that finds nothing
must **not** reset, or the "Processing complete — N enriched" summary would be wiped by
the very next tick, 60 s after finishing — so the boundary fires on work *re-appearing*
(`wasDrained && total > 0`), not on the queue emptying.

The restart boundary exists because a restored tally belongs to the *previous* process —
a deploy once carried 2,300 pre-fix sidecar failures into a perfectly healthy run's
display. The restored counts remain visible until the new process's first batch (so the
panel still shows last-known state after a reboot), then reset.

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
| PUT | `/api/admin/processing` | Update settings (enable, pause, per-task flags, landing gates, hold-for-review) |
| POST | `/api/admin/processing/run` | `runNow()` (overrides `paused`) |
| POST | `/api/admin/processing/stop` | `cancelRun()` |
| GET | `/api/admin/processing/stream` | SSE status snapshots (progress bar + snippets) |

All admin-only; `503` when the service isn't wired.

## Web

Admin-only **Library processing** panel in Settings (`data-testid="processing-panel"`):
enable toggle, per-task checkboxes (greyed with the
availability reason when ffmpeg/Lidarr is missing), a progress bar + live snippet
list driven by an `EventSource` on the stream endpoint, and Run now / Stop. Percent
and phase-label math is the DI-free, unit-tested `lib/processing-progress.ts`.

**Feedback (this change):** "Run now" is disabled while a run is starting or in progress
(`runNowDisabled()`, label flips to "Running…"); "Stop" is disabled unless a run is
active. A failure count + reason renders in the progress area (`data-testid="processing-failed"`).
When a *user-initiated* run settles, the panel toasts the outcome via `ToastService`
(error with the reason if any item failed, success otherwise) — gated on having seen a
`running` frame so background runs and the priming frame stay silent. The pure
`runOutcomeToast` / `isRunning` helpers in `lib/processing-progress.ts` carry that logic
and are unit-tested.

## Runtime load controls + sidecar status

Prod host `kpc` shares one **P4000 8 GB** across NicotinD analysis, Immich ML and Ollama, so
processing load is a shared-resource concern, not just a throughput knob.

There used to be a "compute throttle" panel here exposing `concurrency`, `batchSize` and a
`gpuBusyPercent` courtesy yield (issue #224). **All three were removed.** Issue #224's own
follow-up measured the yield and found it changed neither throughput nor GPU memory — it was
never a GPU regulator, only a scheduler skip — and the other two are implementation details no
operator was ever asked to reason about. They are now the constants `PROCESSING_CONCURRENCY`
(3, into `createEnrichmentContext({ concurrency })`) and `PROCESSING_BATCH_SIZE` (25, tracks
claimed per pass) in `library-processing.service.ts`. `LibraryProcessingDeps.batchSize` exists
only as a **test seam** — no route, config file or UI writes it.

`paused` below is the surviving lever, and is now also the way to stand down while another
tenant needs the card.

### `paused` — a runtime throttle, not an off switch

`enabled: false` is a *persistent* statement ("this deployment does not do background
enrichment"). Pausing is the different, temporary thing an admin wants when another tenant needs
the GPU **right now**: stop the background work, but don't reconfigure the install.

`ProcessingSettings.paused` (+ the `paused` member of `ProcessingPhase`) is that lever, and it is
deliberately weaker than `enabled` in three ways:

- **It never strands a download.** The paused branch in `tick()` sits *after* the `enabled` gate and
  still runs `kickEagerInner()` whenever `hasQuarantined()` — a freshly-downloaded song clears its
  landing gate and becomes visible even while paused. Only background enrichment is skipped.
  Pausing would otherwise leave new music invisible in quarantine with no indication why.
- **`runNow()` overrides it.** The admin override reads no pause flag, so "Run now" still drains.
  Pause throttles the *automatic* loop, not the human pressing the button.
- **`enabled: false` wins the label.** When both are set the phase reports `disabled`, because the
  persistent statement is the more informative one.

Persisted settings written before this field existed have no `paused` key;
`getProcessingSettings` merges over `DEFAULT_PROCESSING_SETTINGS` so they read `false` rather than
`undefined`. `PUT /api/admin/processing` rejects a non-boolean with a `400`, and the Admin panel
exposes it as `data-testid="processing-paused"`.

## One-time prod backfill

For an existing library, run the manual scripts inside the container once to fill
the backlog quickly (the processor then keeps up with new downloads):

```bash
docker exec <container> bun run packages/api/src/scripts/backfill-genre.ts --apply       # fast, needs Lidarr
docker exec -d <container> bun run packages/api/src/scripts/analyze-bpm.ts --apply --concurrency 4   # slow, offline
docker exec -d <container> bun run packages/api/src/scripts/analyze-key.ts --apply --concurrency 4   # slow, offline
docker exec -d <container> bun run packages/api/src/scripts/analyze-energy.ts --apply --concurrency 4  # slow, offline
docker exec -d <container> bun run packages/api/src/scripts/analyze-audio-features.ts --apply          # needs the analysis sidecar up
```

All are dry-run without `--apply` and resume on re-run. **Run them sequentially**, not
concurrently — multiple writer processes plus the app fight over the SQLite write
lock. Prefer the in-process processor (or admin **Run now**) over scripts:
it shares the app's connection (no lock contention) and completes tag+DB per song so
nothing reverts on the next full scan.

### BPM octave-error repair (`--recheck`)

The pre-sidecar library was BPM'd by music-tempo, which wrote octave errors
(half/double tempo) into **both** the DB and the file tags. `--recheck`
re-detects *every* song via the sidecar (required: `NICOTIND_ANALYSIS_URL`),
deliberately ignoring the poisoned tags, and overwrites only when the new
detection is confident and disagrees — policy is the unit-tested
`shouldUpdateBpm` in `track-backfill.ts` (fill any NULL; overwrite an existing
value only when Essentia confidence ≥ `--min-conf`, default 1.5 on its 0–5.32
scale, and the difference exceeds ±2 BPM). ~1.3 s/track sidecar analysis, so a
10k-song library is a few hours:

```bash
NICOTIND_ANALYSIS_URL=http://<analysis-host>:8000 \
  bun run packages/api/src/scripts/analyze-bpm.ts --recheck            # dry run, prints planned changes
NICOTIND_ANALYSIS_URL=http://<analysis-host>:8000 \
  bun run packages/api/src/scripts/analyze-bpm.ts --recheck --apply    # write DB + tags (log: analyze-bpm-recheck.log)
```
