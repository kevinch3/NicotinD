# Audio analysis & enrichment

One section of [the index](../index.md). Entry shape and caps are unchanged and
`bun run check:claude-md` still enforces them here.

- **Library processing**: resumable background enrichment via an extensible task registry, run
  continuously while enabled; failures are diagnosed and tallied into `ProcessingStatus`, and broken
  or undetectable files are excluded via a `library_song_analysis_failures` ledger.
  `NoConfidentResultError`, `AudioFileRejectedError`. → [library-processing.md](../library-processing.md)
- **A retired task leaves nothing behind**: `PROCESSING_TASK_IDS` is the one runtime list of live
  tasks (the `ProcessingTaskId` union derives from it); `applySchema` sweeps ledger rows for anything
  absent from it and the settings blob is filtered the same way.
  → [library-processing.md](../library-processing.md)
- **Processing pause**: a `paused` flag is the runtime halt distinct from `enabled: false` (landing
  is unaffected), and the manual way to stand down for another GPU tenant. The failure tally's
  session boundary is one continuous drain (`drained`), not a time window.
  → [library-processing.md](../library-processing.md)
- **Analysis sidecar GPU behaviour**: `RegistryHolder` + `IdleReleaseGuard` drop the warm registry
  after an idle timeout and reload lazily; `peek()` reads without touching the guard and `can_serve()`
  backs `/health`; `musicnn_batch_size` bounds the one predictor that dominated VRAM.
  → [audio-ml-enrichment.md](../audio-ml-enrichment.md)
- **Instant landing**: a scanned song is visible at once; `landed_at` is stamped by the scanner on
  INSERT (first seen, preserved on rescan) and serves only as the new-album watermark and recency key;
  `enrichNewSongsNow` nudges enrichment after each scan, `landing_backfill_v2` stamps pre-gate NULLs.
  → [library-processing.md](../library-processing.md)
- **A pool that cannot advance**: an un-ledgered failure plus a fixed pool order livelocks a
  `LIMIT`-bounded task on its own head: every un-ledgered path stamps `noteAnalysisAttempt`,
  every song pool orders on `leastRecentlyAttemptedOrderSql`, and tag-sourced ids pass core
  `isMbidShape` before any batch call.
  → [library-processing.md](../library-processing.md), [popularity.md](../popularity.md)
- **Perceptual audio features (no LLM)**: energy/loudness via ffmpeg ebur128; danceability, valence,
  mood, vocals, acousticness and cached embeddings from the Essentia sidecar; all written to file tags
  and COALESCE-preserved columns. `library_embeddings`, `embedding-store.ts`.
  → [audio-ml-enrichment.md](../audio-ml-enrichment.md), [radio.md](../radio.md)
- **Every sidecar decode is windowed**: `load_audio` buffers the whole ffmpeg stream, so an
  unwindowed `/analyze` made peak host RSS scale with track length (~1.98 GB for one 8 h file).
  `analyze_window_seconds` / `ANALYSIS_ANALYZE_SECONDS` bounds it, as `descriptor_window_seconds`
  already did. → [audio-ml-enrichment.md](../audio-ml-enrichment.md)
- **Audio descriptors — timbre / groove / spectral balance**: sidecar `/descriptors` + store, then
  three composite radio axes (formula v8): `descriptorBlocks` splits a row into
  `TIMBRE_NAMES`/`GROOVE_NAMES`/`BAND_NAMES`, scored by `blockCosineCloseness` and
  `spectralBalanceCloseness`; `DESCRIPTOR_NORM` holds the z-score constants.
  → [audio-descriptors.md](../audio-descriptors.md), [radio.md](../radio.md)
