# Audio descriptors — timbre, groove, spectral balance (issue #640)

Per-track descriptors from the analysis sidecar's `POST /descriptors`, stored raw in
`library_song_descriptors`, feeding three composite radio axes (phase 2, #642). This page is
the detail behind the CLAUDE.md index line; the umbrella is #640, this phase is #641.

## Why

Radio and "similar songs" score candidates on 12 axes (`DEFAULT_WEIGHTS`,
`services/radio.service.ts`, summing to 66). None of them describes **what the drums are doing**
or **where the spectral energy sits**. Two tracks at the same BPM — a cuarteto record and a
hard-electronic one — tie at 1.00 on `bpm`, and the only discriminator left is the 1280-d learned
embedding (weight 8 against genre's 18).

An audit of the 30 parameters the feature request listed found **5½ present** (BPM, key, mode
inside the Camelot ring, LUFS/energy, vocal/instrumental, the embedding), **7 computed and thrown
away** (the beat grid and inter-beat intervals destructured into `_beats, _intervals` at
`rhythm.py`, LRA parsed by `loudness-analysis.ts` then dropped at the `return`, `arousal` from the
emomusic head discarded in `models.py`), and the rest absent. `mood`, `loudness` and `popularity`
are stored but never scored — not a bug this change fixes, but worth knowing.

## Decisions

- **Composite axes, not 40 individual weights.** `RADIO_FORMULA_VERSION` is 4 after exactly one
  calibration round of 70 votes; fitting 40 free parameters from 70 votes is overfitting, and v3's
  `SHARE_REFERENCE` already showed a plausible constant shipping wrong. Three blocks — timbre,
  groove, bands — each one pollable weight. Phase 2 (#642) adds the axes; this phase stores the
  raw material.
- **A separate endpoint, not an extension of `/analyze`.** `/analyze` decodes at 16 kHz for the
  models (Nyquist 8 kHz), so the 6–16 kHz band is physically unmeasurable there, and Essentia's
  `OnsetRate` throws on anything but 44.1 kHz. `/descriptors` decodes its own 44.1 kHz window and
  needs **no model files** — a models-less build still serves it, which is why `/health` carries
  a separate `descriptors: bool` and the task gates on `descriptorsSnapshot()`, never on
  `healthy()` (whose `status` describes `/analyze`).
- **A temp WAV, because `MusicExtractor` takes a filename.** The plan as first written ran it over
  the ffmpeg-decoded buffer; it cannot — its only input is a path, loaded through Essentia's
  `AudioLoader`, which has no Opus support (the library's standard codec, as `rhythm.py` already
  documents). ffmpeg decodes the window to a 16-bit WAV, the extractor reads that path, and the
  same file is re-read with `wave` + NumPy for the onset and band passes. One decode per track.
- **Extraction runs in a spawned worker process, not the request threadpool.** Found on prod
  the hour v0.3.61 deployed: while a track was being analysed, the sidecar's own `/health` took
  **5–7 s** (12 of 12 samples from the app container), past the API client's 5 s probe timeout and
  Docker's `--timeout=5s` healthcheck — so the `descriptors` task's availability gate flapped for
  the whole backfill and the dry-run script reported the endpoint missing. Essentia's bindings
  hold the GIL for the entire `MusicExtractor` call; TensorFlow releases it, which is why
  `/analyze` never showed this. `ProcessRunner` (`app/descriptors.py`) runs `extract_raw` in one
  long-lived `spawn`ed child — its own GIL, so the parent answers health in milliseconds; `spawn`
  not `fork` because the parent may hold a CUDA context. A worker that dies surfaces as
  `DescriptorUnavailableError` → **503** (environmental, the song stays pending) and the pool is
  rebuilt on the next call; an exception raised *inside* the worker still propagates as itself →
  422. Cost: one extra Python process importing essentia (first call pays the spawn + import).
- **The "free wins" live here, not in a phase of their own.** Beat statistics and loudness range
  cost nothing *because* this pass runs the algorithms that produce them; standalone they would
  have had no store. `MusicExtractor` emits `loudness_range` itself, so the bun-side `ebur128`
  widening was dropped.
- **One JSON row, not ~40 columns.** A column on `library_songs` is a 13-step contract (scanner
  `COALESCE` upsert, tag mirror, DTO, filter grammar, poll snapshot, …) that only three axes would
  consume. `library_song_descriptors` mirrors `library_embeddings`: `version` (the sidecar's
  `DESCRIPTOR_VERSION` — a definition change re-analyses rather than mixing definitions in one
  axis), `file_size` (#258 content check), `orphaned_at` (#259 prune marker). **Raw values**, so
  the z-score constants phase 2 needs can be re-derived from the store without re-analysing 15k
  files.
- **Never a landing gate, never tag-mirrored.** ~5 s of CPU per track must not strand a fresh
  download, and 40 regenerable floats belong in the store, not the file.
- **Pure Python for the statistics.** CI installs only the `[dev]` extra; numpy is behind
  `[models]`. `beat_stats.py` and `bands.py` are stdlib-only so they import (and test) everywhere;
  the real analyzer imports numpy lazily like `models.py`.

## Measured cost (the spike the plan required)

On the published `nicotind-analysis:release` image, i7 desktop CPU, 180 s window:

| input                                           | MusicExtractor | total (decode + rhythm + onsets + bands) |
| ----------------------------------------------- | -------------: | ---------------------------------------: |
| synthetic 240 s beep + pink noise (Opus)        |         5.19 s |                                   7.63 s |
| La Konga — El mismo aire (MP3, 215 s, cuarteto) |         5.02 s |                                   7.25 s |
| A Vision Of Panorama — Baby Konyawa (MP3, chill) |         5.02 s |                                   7.25 s |
| 90 s window (synthetic)                         |         2.99 s |                                   4.51 s |

The first spike ran `RhythmExtractor2013` separately (1.5–1.6 s); `MusicExtractor` already emits
`rhythm.beats_position`, so the shipped analyzer reads the grid from the pool instead. Real
end-to-end via `EssentiaDescriptorAnalyzer`: **6.15 s** (La Konga) and **5.85 s** (Baby Konyawa).
CPU-bound — no P4000 contention — but `gpuBusyPercent` still yields the whole tick. At 15k tracks
and concurrency 2 that is roughly a day of accumulated window time.

### What the two records look like

The pair the feature request named — same library, the formula today can only tell them apart
by embedding — separate exactly where the new blocks look:

| descriptor          | La Konga (cuarteto) | Baby Konyawa (chill) |
| ------------------- | ------------------: | -------------------: |
| `bpm`               |               150.0 |                103.0 |
| `spectral_centroid` |             1139 Hz |               900 Hz |
| `band_bass`         |                0.32 |                 0.59 |
| `band_mid`          |                0.27 |                 0.11 |
| `tempo_stability`   |                0.77 |                 0.98 |
| `groove_regularity` |                0.92 |                 0.93 |
| `swing_ratio`       |                0.47 |                 0.55 |
| `syncopation`       |                0.15 |                 0.40 |
| `kick_weight`       |                0.76 |                 0.71 |
| `onset_rate`        |              5.25/s |               5.81/s |

A live band drifting (0.77) next to a quantised production (0.98); a mid-heavy brass mix next to a
bass-dominant one. These are the axes phase 2 scores.

## The contract

`POST /descriptors {relPath}` → `{ version, features: { <name>: float | null } }`, same
400/404/422/503 taxonomy as `/rhythm`. **422 is reserved for per-file rejection**
(`AudioFileRejectedError` on the API side, ledgered); 404/503 return `null` and are never
ledgered, so an environmental fault can't exclude the whole library. A `null` value means "the
sidecar could not define that one" (no off-beat onsets → no swing; silence → no band shares) —
the file is fine.

Names, in `DESCRIPTOR_NAMES` order (`app/descriptors.py`); the API groups them by name in phase 2:

| block                | names                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| timbre (21)          | `mfcc_0`…`mfcc_12`, `spectral_centroid`, `spectral_bandwidth` (Essentia `spectral_spread`), `spectral_rolloff`, `spectral_flux`, `spectral_flatness` (`barkbands_flatness_db` — there is no `spectral_flatness_db` key), `spectral_complexity`, `zero_crossing_rate`, `pitch_salience` (HNR is not available) |
| groove (8)           | `onset_rate`, `beat_strength` (`beats_loudness`), `tempo_stability`, `swing_ratio`, `groove_regularity`, `syncopation`, `danceability_dsp` (Essentia's DSP measure, not the learned head), `kick_weight` (`beats_loudness_band_ratio[0]`) |
| bands (6)            | `band_sub_bass` 20–60, `band_bass` 60–250, `band_low_mid` 250–500, `band_mid` 500–2k, `band_high_mid` 2k–6k, `band_high` 6k–16k — shares summing to 1                          |
| scalars (for later)  | `chords_changes_rate`, `key_strength` (the missing key *confidence*), `dynamic_complexity`, `loudness_range`, `bpm`                                                             |

### The groove statistics (`app/beat_stats.py`)

Two numbers deliberately split what one "timing deviation" would blur: **`tempo_stability`**
compares 8-beat *window means* (slow drift — a live band speeding up), **`groove_regularity`**
compares *successive intervals* (fast jitter — push/pull). A metronome scores 1.0 on both; a
drifting grid scores low on the first and ≈1.0 on the second; a jittered grid the reverse. The
test `penalises_beat_to_beat_jitter_not_slow_drift` pins that they cannot collapse into each
other. **`swing_ratio`** is the median off-beat phase (0.5 straight, ≈0.67 triplet; median so a few
strays can't drag a straight groove). **`syncopation`** — Essentia has none, so this one is ours —
is the graded distance of each onset from the eighth-note grid, with a dead zone
(`SYNCOPATION_DEAD_ZONE` 0.06 ≈ 30 ms at 120 bpm): graded rather than thresholded because it feeds
a cosine axis, where a step function makes two tracks a millisecond apart look maximally
different; the dead zone because `OnsetRate` resolves to ~12 ms and a tight human drummer's spread
is of the same order, so without it a quantised track already reads ≈0.09. The straight off-beat
(0.5) scores 0 by construction — `swing_ratio` owns where the off-beat lands.

## API side

- `services/descriptor-store.ts` — `DESCRIPTOR_VERSION` (mirrors the sidecar), `upsertDescriptors`,
  `loadDescriptors` (pooled, chunked, the #258 `file_size IS s.size` guard, current version only)
  and `descriptorsPendingClause` (the task's selection: no row, older version, or stale size).
- `services/audio-features-client.ts` — `descriptors(relPath)` + `descriptorsSnapshot()`; the
  health probe now records `/health.descriptors` beside `status`.
- `services/enrichment/tasks.ts` `descriptorsTask` — `id: 'descriptors'`, default-on, no
  `satisfiedColumnSql`, concurrency ≤ 2 (the sidecar serialises extraction through its single
  worker), stops the batch when health confirms an outage, ledgers only `AudioFileRejectedError`.
- `scripts/backfill-descriptors.ts` — the bulk tool; runs the same task body so the pending
  predicate and ledger can't drift from the scheduler's.
- `services/orphan-prune.ts` — registered with the embeddings (regenerable, ~2 KB/song).
- Admin panel: the task appears in Library Processing (`admin.taskDescriptors`).

## Sidecar configuration

| env                            | default | meaning                                                                                   |
| ------------------------------ | ------- | ----------------------------------------------------------------------------------------- |
| `ANALYSIS_DESCRIPTOR_SECONDS`  | `180`   | length of the analysed head of each track; non-numeric / non-positive falls back to 180   |

## What comes next

- **Phase 2 (#642)** — `descriptor-axes.ts` (timbre + groove as `(cos+1)/2` over z-scored vectors,
  spectral balance as `1 − L1/2` over shares), `descriptor-norm.ts` with constants measured from a
  populated store, `RADIO_FORMULA_VERSION` → 5, `RadioPollSnapshotFeatures` extended with plain
  `number[]` blocks (a `Float32Array` there would be corrupted by `JSON.stringify` — the reason
  `stripFeatures` deletes the embedding), and a fresh poll: the existing 70 votes predate the
  blocks and cannot grade v5.
- **Phase 3 (#643) — shipped**: the waveform/VFX artifact. Sidecar-free (one streaming ffmpeg
  decode + a small radix-2 FFT in TS, on demand, content-addressed on disk), so it does not depend
  on this store at all. Detail in [web-ui.md](web-ui.md) "Now Playing waveform + karaoke VFX" and
  [cache-invalidation.md](cache-invalidation.md) (`waveform-cache`).

## Deferred

Structure segmentation (needs `SBic` or a model + its own calibration); instrument-presence heads
(a second model tier for a different problem); raw-feature filters and station chips (composites
were chosen over columns); scoring the already-stored `mood`/`loudness`/`popularity`.
