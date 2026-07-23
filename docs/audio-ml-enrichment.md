# Audio-ML metadata enrichment (Essentia → tagging models)

Design + implementation record for the model-dependent metadata wishlist — valence,
danceability, acousticness, mood/vibe, instrumentation/vocal-presence — that the
light deterministic enrichment (key/bpm/genre, see
[library-processing.md](library-processing.md)) can't produce. Status: **built**
(2026-07, minus section markers and the LLM layer — see below). The sidecar lives
in `packages/analysis/`; the bun side is the `audio-features` + `energy`
enrichment tasks.

The shipped pipeline:

1. **Essentia** extracts an embedding per track (EffNet-Discogs 1280-d, plus a
   MusiCNN 200-d for the valence head).
2. **Tagging/classification heads** run on the embedding and produce the labels
   (mood, danceability, valence, voice/instrumental, acousticness, genre).
3. ~~The labels + embedding feed an **LLM** for narrative descriptions~~ —
   **dropped scope**: the user chose pure audio analysis; no LLM anywhere in the
   pipeline. The catalogue + deterministic recipes (playlist-generation.md §2)
   consume the labels directly. §3.4/§5.5 below are therefore not pursued.

## Implementation decisions (as built)

- **D1 — energy/loudness are bun-side, not sidecar**: `loudness-analysis.ts`
  spawns ffmpeg `ebur128` and derives a 0..1 energy from integrated LUFS +
  loudness range. They work with no sidecar (the degradation requirement) and
  have exactly one writer per column. Two tasks: `energy` (ffmpeg-gated) and
  `audio-features` (sidecar-health-gated).
- **D2 — tag keys**: `ENERGY`, `LOUDNESS_LUFS`, `VALENCE`, `DANCEABILITY`,
  `ACOUSTICNESS`, `INSTRUMENTALNESS` (0..1 / LUFS numerics) and `MOOD`
  (happy|sad|aggressive|relaxed|party) — written as Vorbis comments and ID3 TXXX
  by `audio-tags.ts`, read back by the scanner (`featureTagsFromNative`) so
  tagged files are dense from the first scan on any install.
- **D3 — valence normalization in the sidecar**: the emomusic head emits 1..9;
  the HTTP contract is uniformly 0..1. Mood = argmax over the five mood heads
  (per-head class order is inconsistent — encoded in `app/features.py`).
- **D4 — CPU by default, GPU as a build ARG (with inherent CPU fallback)**: the
  `essentia-tensorflow` wheel bundles CPU libtensorflow 2.5.0. `--build-arg
  GPU=1` (Dockerfile) swaps the vendored lib for **Google's official GPU build
  of the exact same version** (sha256-pinned) and pip-installs the CUDA-11
  runtime wheels (`[gpu]` extra in pyproject). Mechanics: the essentia
  extension links the vendored file by its auditwheel-mangled name via
  `$ORIGIN` RPATH, so the GPU `.so` is dropped in **under that exact name**;
  its `libtensorflow_framework.so.2` dependency lands alongside (resolved via
  the extension's inherited DT_RPATH). **Fallback is TF's own behavior, not
  ours**: CUDA libs are `dlopen`'d, so a GPU image started without a GPU (or
  on a driverless host) silently runs on CPU — one image works everywhere.
  `runtime_device()` (`app/models.py`) mirrors that rule for `/health`:
  "gpu" only when `ANALYSIS_GPU_BUILD=1` (baked by the ARG) *and* a probe of
  `libcuda.so.1` reports a device. `TF_FORCE_GPU_ALLOW_GROWTH=true` is set so
  TF doesn't grab all GPU memory (the card may be shared, e.g. with a game
  streamer). Enable per-host via a compose override (build arg + nvidia device
  reservation — see the commented block in docker-compose.yml).
- **D5 — `library_embeddings` keyed `(song_id, model)`** so a second embedding
  model can coexist; the vec is a packed Float32 blob, reused later for
  similarity (playlist-generation.md §2b).
- **Sidecar contract**: `POST /analyze {relPath}` resolved against the sidecar's
  own `MUSIC_DIR` (no shared absolute paths); `GET /health` reports
  `modelVersions` (the drift anchor) plus `rhythm` (tempo availability). Models
  pinned by URL + sha256 in the Dockerfile (~27 MB total).
- **D6 — `genre_discogs400` head (issue #187 task A2, an audio-inferred genre
  fallback)**: the classifier head this section's own "recommended stack"
  table always listed but that was never wired up, closing the gap. It's a
  400-way **multi-label sigmoid** (`op: Sigmoid`, per the model's published
  schema) over the *same* EffNet-Discogs frames `audio-features` already
  computes — no second embedding pass. `app/genre_labels.py` bundles the 400
  Discogs `"Genre---Style"` class labels (e.g. `"Rock---Alternative Rock"`)
  as a committed JSON data file (`app/data/genre_discogs400_labels.json`),
  fetched from the model's own published metadata rather than
  hand-transcribed. `app/features.py`'s pure `derive_genre()` takes the
  top-1 label, splits genre from style, and reports the sigmoid probability
  as `confidence`. **`genre` is a sibling field on `/analyze`'s response, not
  folded into `features`** — a genre-parsing bug must never null out real
  perceptual-feature data (`AnalysisResult.genre` defaults to `None` so
  older callers/tests are unaffected). The bun-side `genre-audio` fallback
  task that consumes this (confidence-gated via `NICOTIND_GENRE_AUDIO_CONFIDENCE`,
  default 0.5; provenance-tagged via `library_genre_overrides.source =
  'essentia'`) shipped in a follow-up PR — see
  [library-processing.md](library-processing.md) ("genre-audio") and
  [library-scanner.md](library-scanner.md) "Audio-inferred genre fallback
  (Essentia)" for the task predicate, ledger behavior, and the race-with-
  `genreTask` fix (the fallback only fires once `genre` has already ledgered
  the song as unresolved — a last resort strictly *below* MusicBrainz/Lidarr,
  deliberately weak on regional genres like Chamamé/Argentine folclore).
  `AudioFeaturesClient`'s `genre` field parses independently of `features` in
  bun too, for the same reason: an older deployed sidecar predating this head
  must degrade to `genre: null`, not fail the whole `/analyze` payload.
- **`POST /rhythm {relPath}` → `{bpm, confidence, method}`** (`app/rhythm.py`,
  Essentia RhythmExtractor2013 *multifeature* over an ffmpeg-decoded 90 s
  44.1 kHz slice, ~1.3 s/track). Added because the bun-side detector
  (music-tempo) makes frequent octave errors — half *and* double tempo, ~50%
  of a prod sample — while RhythmExtractor2013 matched known tempos on every
  confident spot-check. Deliberately independent of the TF model registry
  (tempo needs no models, so /rhythm keeps working when model files are
  absent; injectable `RhythmAnalyzer` protocol mirrors `ModelRegistry` for
  contract tests). Consumed by `AudioFeaturesClient.rhythm()`: the bpm
  enrichment task, the on-demand analyze route, and
  `scripts/analyze-bpm.ts --recheck` (octave-error repair — see
  library-processing.md) all prefer it over music-tempo. `confidence` is
  Essentia's 0–5.32 scale (in practice <1.5 = poor lock).
  **Time signature was evaluated and rejected**: Essentia's `Meter`
  (BeatsLoudness → Beatogram chain) returned 2.0 for 4/4 AC/DC and 12.0 for
  6/8 Metallica — too unreliable to store; proper meter needs downbeat
  tracking (madmom-class dependency), deferred.
- **Decoding is ffmpeg, not Essentia's loader** (found in live verification):
  the essentia pip wheel's bundled AudioLoader can't decode Opus — the
  library's standard codec — so `app/models.py load_audio` decodes any codec
  to 16 kHz mono f32 via the ffmpeg CLI (installed in the image) and feeds the
  raw PCM to the TF predictors. Golden test `test_opus_decodes` guards this.
- **Vorbis tag writes were silently broken app-wide** (also found in live
  verification): `writeFfmpegTags`' tmp output ends in `.nicotind.tmp`, so
  ffmpeg could not infer a muxer and every Opus/FLAC/ogg/m4a tag write failed
  (bpm/key/genre/lyrics included) — masked by the COALESCE durability
  contract. Fixed with an explicit `-f <muxer>` per extension; an ffmpeg-gated
  Opus round-trip test in `audio-tags.test.ts` guards it.

## 0. Recommended model stack (the answer)

**Use Essentia-TensorFlow as the core of steps 1+2** — it already bundles both the
embeddings *and* a full suite of MTG-Jamendo classifier heads, so one library covers
feature extraction and tagging. Concretely:

| Role | Choice | Why |
| --- | --- | --- |
| Low-level features + framework | **Essentia (essentia-tensorflow)** | C++/Python, music-tuned, ships pretrained models + extractors; the de-facto choice |
| Primary embedding | **EffNet-Discogs** (`discogs-effnet-bs64`, 1280-d) | modern, music-specific (Discogs), best tagging accuracy; one embedding feeds every head |
| Secondary embedding (similarity / portability) | **MusiCNN-MSD** (200-d) | tiny, fast, good for the "more like this" vector in playlist-generation.md §2b |
| Classifier heads (on the embedding) | Essentia MTG models: `danceability`, `mood_{happy,sad,aggressive,relaxed,party,electronic,acoustic}`, `voice_instrumental`, `genre_discogs400`, valence/arousal (`deam`/`emomusic`) | covers the whole wishlist; each head is a tiny MLP on the cached embedding |
| Narrative / concepts / naming | **Claude (latest model)** via the existing plugin/LLM path | structured outputs only (filters, labels, prose), weekly + cached |

VGGish/OpenL3 are viable embeddings but EffNet-Discogs + MusiCNN are
better-matched to music tagging and lighter; OpenL3 is notably slower on CPU. We can
add OpenL3 later if a downstream task needs its embedding space.

> **Acousticness** = the `mood_acoustic` head; **instrumentation/vocals** =
> `voice_instrumental`; **valence** = `deam`/`emomusic` valence; **danceability** =
> the `danceability` head; **mood** = the `mood_*` ensemble. **Section markers** are
> *not* an Essentia classifier — they need structural segmentation (e.g.
> `msaf`/`all-in-one`); treat as a separate, later, heavier task.

## 1. Architecture — a GPU Python sidecar

Essentia/TensorFlow is a Python/C++ stack; NicotinD is Bun/TypeScript. So the models
live in a **separate `analysis` service** in the compose stack, not in the API
container:

```
@nicotind/api (bun)                          analysis sidecar (python, GPU)
  EnrichmentTask "audio-features" ──HTTP──▶  POST /analyze {path}
    (windowed processor)          ◀──JSON──   { embedding:[…], tags:{danceability,
                                                 valence, mood, instrumental, …},
                                                 model_versions:{…} }
```

- **Sidecar** (`packages/analysis/` or a `Dockerfile.analysis`): FastAPI + Essentia-
  TensorFlow, models **loaded once at startup and kept warm**, GPU-enabled
  (`runtime: nvidia` / device reservation — the host has a Quadro P4000). Reads the
  shared `/data/music` volume (same mount the API uses), returns embedding + labels.
  Stateless; the bun side owns the DB.
  **Deployment pitfall**: the sidecar resolves `relPath` against *its own* mount, so
  every music-volume override (e.g. the host bind in `docker-compose.override.yml`)
  must be applied to the `analysis` service too. If it isn't, the API decodes files
  fine while the sidecar 404s every `/analyze` call, and the whole audio-features
  backlog silently stays pending (this happened in prod: the override rebound
  `/data/music` for nicotind/slskd/lidarr but left `analysis` on the empty named
  volume).
- **Bun side**: a new `audio-features` `EnrichmentTask` (same registry/window/resume
  pattern as key/bpm/genre) calls the sidecar, **caches the embedding** in a
  `library_embeddings` side-table (keyed on `songId`; reusable for *every* head + the
  similarity engine in playlist-generation.md §2b) and writes the derived labels to
  new `library_songs` columns (`danceability REAL`, `valence REAL`, `acousticness
  REAL`, `instrumental REAL`, `mood TEXT`) — additive, COALESCE-preserved on rescan
  like bpm/key. Gate the task on sidecar reachability (degrade gracefully when it's
  down, exactly like the Lidarr/ffmpeg gates).
- **LLM step**: a separate weekly job (not per-track in the hot path) that reads the
  cached labels + library aggregates and produces playlist concepts/names/blurbs via
  the existing plugin LLM path. Pure prompt-build + structured-parse; schema-validate
  every LLM-proposed filter before use.

Why a warm sidecar and not a per-track CLI: TF model load is multi-second; a
per-track `spawn` would pay it 7043×. A warm service amortizes it to ~zero.

## 2. Data model

- `library_embeddings(song_id PK, model TEXT, dim INT, vec BLOB, updated_at)` — the
  EffNet/MusiCNN vector (Float32 packed). The expensive artifact; compute **once**,
  reuse for all heads + similarity. Survives rescans (keyed on path-derived songId).
- `library_songs` additive columns: `danceability`, `valence`, `acousticness`,
  `instrumental` (0..1 reals), `mood` (text label). COALESCE-preserved (see the
  durability contract in library-processing.md).
- `ProcessingTaskId` gains `'audio-features'` (+ web shim + Settings checkbox).

## 3. Deterministic test strategy

Model inference is float-valued, so we **don't** assert exact numbers in CI. Three
deterministic layers:

1. **Plumbing / contract tests (bun, in CI)** — the `audio-features` task + sidecar
   client tested against a **mocked sidecar** returning fixed JSON (the established
   injected-fake pattern from `enrichment/tasks.test.ts`): assert DB + embedding-table
   writes, label ranges, COALESCE durability, resume (`… IS NULL` reselect), and
   graceful 503 when the sidecar is unreachable. Fast, hermetic, no model.
2. **Invariant / range tests (python sidecar, own job)** — for any input: every score
   ∈ [0,1]; `mood` ∈ the known vocab; embedding length == declared `dim`; identical
   input → identical output (determinism); `model_versions` present. These hold
   regardless of the audio.
3. **Golden-fixture + discriminative tests (python, gated)** — commit a few tiny
   fixtures (synthetic + short CC clips): (a) **snapshot** each model's output and
   assert future runs match within an epsilon → catches model/version drift; (b)
   **discriminative sanity**: white-noise vs. a pure tone → `instrumental` separates;
   a 4-on-the-floor 128-BPM synthetic → `danceability` high; a solo-voice clip →
   `voice_instrumental` leans voice. Loose thresholds, deterministic direction.
4. **LLM step (bun, in CI)** — the prompt-builder and structured-output parser are
   pure functions tested with fixed fixtures; assert every LLM-proposed filter
   validates against the recipe schema (reject hallucinated columns). No live LLM.

These give a green CI signal without a model present, plus a model-present job that
guards accuracy drift — mirroring how the rest of the codebase tests fuzzy subsystems
(pure logic in CI, integration gated).

## 4. Compute budget — this server (i7-6700K, 31 GiB, Quadro P4000)

Library: **7043 tracks, ~4 min avg**. The **P4000 (8 GB, ~5.3 TFLOPS FP32)** is the
decisive factor — it's shared with the wolf/game-streaming containers but idle most
of the time.

| Path | Per track (decode + embed + heads) | Full library (7043) | Notes |
| --- | --- | --- | --- |
| **GPU (P4000), warm sidecar** | ~1–2 s | **~2–4 h** single-stream; **<1 h** if batched | embedding once; heads ~free; ffmpeg decode dominates |
| CPU-only (8 threads), warm | ~8–15 s | ~16–30 h single; **~4–6 h** at 4–6 workers | TF on AVX2; fine as a fallback |
| Section markers (later) | ~10–30 s (GPU) | several h | structural model, separate pass |
| LLM (weekly, concepts/blurbs) | n/a | minutes + cents | aggregate prompts, cached; not per-track |

Recommendation: **GPU sidecar, batched, embeddings cached.** First full pass ~2–4 h
on the P4000 (run it in the existing maintenance window); thereafter only new
downloads are processed (seconds each). Re-running heads after a model update is
~free because embeddings are cached. RAM is a non-issue (21 GiB free; each model set
~1–2 GiB). **Caveat:** the P4000 is shared with wolf — schedule the bulk pass when
game streaming is idle, and the windowed processor already confines heavy work to the
configured hours.

**Measured (2026-07-08, P4000, GPU=1 image, same track, warm models):** CPU 21.4 s →
GPU 5.4 s per track (~4×; the residual is the CPU-side ffmpeg decode, which now
dominates). First GPU inference adds ~4 s of one-time cuDNN autotune. TF holds
~4.3 GB VRAM with `TF_FORCE_GPU_ALLOW_GROWTH=true` (coexists with other GPU tenants
on the 8 GB card — keep an eye on it if another large model is resident). CPU/GPU
outputs are numerically identical (embedding max |Δ| ≈ 2e-7, features equal).

> Contrast: the current pure-JS `key` analysis is CPU-bound at ~3–4 s/track (~7 h)
> precisely because it can't use the GPU. Moving heavy DSP/inference to the GPU
> sidecar is the structural fix — and a candidate to *also* offload key/bpm later.

## 5. Rollout phases

1. **Sidecar skeleton** — ✅ built (`packages/analysis/`): FastAPI + Essentia-TF,
   `GET /health`, `POST /analyze` with embedding + all heads; compose service
   (CPU default, `--build-arg GPU=1` variant with inherent CPU fallback — D4);
   warm load at startup.
2. **bun `audio-features` task** — ✅ built: `audio-features-client.ts`,
   `library_embeddings` + label columns, registry entry, Settings checkbox,
   mocked-sidecar plumbing tests. Gated on live sidecar health. Bulk script:
   `scripts/analyze-audio-features.ts` (tag-first, resumable). The bun-side
   `energy` task + `scripts/analyze-energy.ts` cover energy/loudness (D1).
3. **First windowed backfill** — pending on prod (enable both tasks, or run the
   scripts; ~4–6 h CPU); verify durability + resume after.
4. **Similarity** — future: nearest-neighbour over cached embeddings
   (playlist-generation.md §2b) → "more like this" + clustering.
5. **LLM concept/naming pass** — **not pursued** (dropped scope — no LLM).
6. **Section markers** — future, separate heavier task.

## 6. Risks / open decisions

- **GPU sharing** with wolf — confine to the maintenance window; consider an MPS/time
  guard. CPU fallback documented if the GPU is unavailable.
- **Model licensing/size** — Essentia MTG models are CC; bake them into the sidecar
  image (pinned versions in `model_versions` for the drift test).
- **Python in a Bun monorepo** — isolated to `packages/analysis/`; built as its own
  image in CI, deployed as a compose service. No bun dependency on Python.
- **Accuracy expectations** — these are *estimates* (valence/mood especially); surface
  them as soft signals for playlisting, not ground truth, and keep them user-overridable
  like the metadata-fix flow.

→ Feeds [playlist-generation.md](playlist-generation.md) §3–4; extends the task
pattern in [library-processing.md](library-processing.md).
