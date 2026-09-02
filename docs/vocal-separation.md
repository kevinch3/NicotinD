# Vocal separation (karaoke instrumental stems)

**Status:** shipped in two PRs (issue #603): the sidecar image + GPU compose overlay + CI/deploy
first, then the API + web half below. Opt-in per instance (Admin → Streaming & media); without
the sidecar, or with the opt-in off, the karaoke vocal mute is the ffmpeg center-cancel
"basic" filter (`?vocals=off`, `docs/design-patterns.md` "Vocal mute").

Follows [vocal-isolation-spike.md](vocal-isolation-spike.md) (2026-08-20), which picked the
model and measured it, and the four owner decisions of 2026-09-02 recorded on #603:
wait for the whole stem (no chunk-by-chunk serving), start on karaoke-overlay open + the
next queued track, keep center-cancel as a labelled "basic" fallback, keep the original
mix playing while a stem prepares.

## The sidecar — `packages/separator/`

A FastAPI service mirroring `packages/analysis/` (same `/health` conventions, same
`MUSIC_DIR` read-only mount, same "503 = environmental, 422 = a verdict on the file"
split), running **BS-RoFormer** (`anvuew/BS-RoFormer`,
`bs_roformer_ft1_anvuew_sdr_12.55.ckpt`, GPL-3.0, 51 M params, `num_stems: 1` — it
predicts the *vocals*; the instrumental is mix − vocals).

```
GET  /health    → { status: 'ok' | 'unavailable', device: 'cuda' | 'cpu', gpu, loaded,
                    model, modelVersion, reason: null | 'no-cuda' | 'checkpoint-missing'
                    | 'load-failed' }
POST /separate  { relPath } → 200 audio/flac  (44.1 kHz stereo 16-bit instrumental)
                    + X-Source-Duration-Sec, X-Separator-Model
                 400 path escapes MUSIC_DIR · 404 missing file
                 422 undecodable / < 1 s / > SEPARATOR_MAX_TRACK_SEC   (deterministic)
                 503 no CUDA / model not loadable / worker died / timeout (environmental)
```

`status: 'ok'` **includes the idle-released, cold state** (`loaded: false`) — the same
#539 lesson as the analysis sidecar: a health gate that reads "cold" as "down" would block
the very call that warms it. `unavailable` is structural and does not recover without a
rebuild or a different host: no CUDA, missing checkpoint, or a checkpoint that failed to
load once (`load-failed` is sticky — the files are baked into the image, so it fails the
same way every time).

### Why the model lives in a worker process

`app/worker.py` `SeparationWorker` is one spawned (`spawn`, never `fork` — a CUDA context
does not survive a fork) long-lived child that owns the model and the CUDA context. It is
the analysis sidecar's `ProcessRunner` plus the two things that pattern lacks:

- **a per-call timeout that kills the worker** (`max(120, duration × 1.0 + 60)` s, ~4× the
  measured RTF). A `ProcessPoolExecutor` cannot cancel a running task, so a hung inference
  would hold the GPU until the container restarted. The API's own fetch timeout is the
  authority; this is the backstop that frees the card without a client.
- **`stop()`**, called from the FastAPI lifespan and by idle release. Stopping the process
  is what actually returns VRAM: `del model; torch.cuda.empty_cache()` in-process never
  gives back the CUDA context. This is also why `app/idle_release.py` copies only
  `IdleReleaseGuard` from the analysis sidecar — there is no registry to hold, release *is*
  `worker.stop()`. `SEPARATOR_IDLE_RELEASE_SEC` (default 900) → the worker is gone, the
  card shows 0 MiB for this container, and the next `/separate` pays a cold start.

The serving process never imports torch: the boot-time GPU probe (`app/device.py`) runs in
a throwaway child too. `/health` therefore answers in milliseconds during a 55 s job.
Calls are serialised by one lock — the GPU is one resource; the API queues on its side.

### Chunking (`app/chunking.py`)

Inference runs on the checkpoint's `chunk_size` (960,000 samples = 21.77 s at 44.1 kHz,
the unit the RTF was measured in) with a **2 s crossfaded overlap** (`OVERLAP_SAMPLES`):
neighbouring windows are joined by complementary linear ramps whose weights sum to exactly
1 at every sample, so a chunk boundary is never a click. The config's `inference.num_overlap:
4` was deliberately **not** adopted: it re-predicts every sample four times and averages —
a quality refinement that would take the measured RTF 0.261 to ~1.0, slower than playback.
The 2 s crossfade costs ~10 % (a 19.77 s step instead of 21.77 s).

### Loading the checkpoint (`app/model_config.py`, `app/model.py`)

The checkpoint was trained with ZFTurbo's fork of `bs_roformer`; its `config.yaml` carries
four fork-only keys (`linear_transformer_depth`, `mlp_expansion_factor`,
`use_torch_checkpoint`, `skip_connection`), all falsy or default. The loader keeps only the
keys upstream `BSRoformer.__init__` actually accepts — filtered **by signature**, not by that
list, so a pin bump that changes the constructor fails loudly. `bs-roformer==0.4.1` is the
last release whose block layout matches (0.6.1 → 1.2.4 mismatch 620–668 tensors); the load
is `strict=True` for the same reason. `!!python/tuple` is the only non-standard YAML tag,
handled by one constructor on `SafeLoader` — no `UnsafeLoader`.

0.4.1 wraps attention in `torch.backends.cuda.sdp_kernel(...)`, deprecated since torch 2.2
for `torch.nn.attention.sdpa_kernel([...])`. `ensure_sdp_kernel_shim` installs the mapping
**only when the old name is gone**, so the configuration the RTF was measured with
(mem-efficient + math on a Pascal card; lucidrains' `Attend` picks flash only on an A100)
survives a torch that removed it.

**The image build is the contract test**: after installing, the Dockerfile constructs the
model on CPU and strict-loads the checkpoint. A torch/bs-roformer drift fails the build,
not the first karaoke play in prod. The CI smoke build (`GPU=1`) runs the same step.

### Torch pin and the Pascal card

PyTorch removed Maxwell/Pascal (`sm_50`–`sm_61`) from its **CUDA 12.8+** wheels in torch
2.8 and keeps **CUDA 12.6 as the legacy lane** (through at least 2.12 per the release RFCs;
2.13.0+cu126 wheels exist). The prod card is a Quadro P4000 (`sm_61`), its driver 580
(CUDA 13-capable), so the image installs `torch==2.13.0+cu126` from the PyTorch cu126
index **before** `bs-roformer` (whose `torch>=2.0` would otherwise pull the default cu128
wheel and silently drop the card), then asserts the build can run a cc 6.1 card. That assert
is **not** `'sm_61' in get_arch_list()` — the cu126 wheel ships `sm_60` and no `sm_61`, and the
first build failed on exactly that. CUDA SASS is forward-compatible within a compute-capability
*major* (an `sm_60` kernel runs on 6.1, never on 5.x or 7.x), which is how the P4000 has ever run
torch at all; `app/device.py` `arch_supported` encodes that rule and both the Dockerfile guard
and the boot probe use it.
The spike's "must be torch 2.4.1+cu121" was a symptom of this, not a law.

## Deployment

The service lives **only in `docker-compose.gpu.yml`** (see that file's header): it has no
meaningful CPU variant (RTF 4.1×, ~14 min per song — the app reports `unavailable` on a
CPU box unless `SEPARATOR_ALLOW_CPU=1`, a local-smoke knob never set in prod), so the
published `ghcr.io/kevinch3/nicotind-separator` image *is* the GPU build and the overlay
pulls it. A CPU deploy must not pull a multi-GB torch image to run a permanently
`unavailable` container. `NICOTIND_SEPARATOR_URL=http://separator:8000` is set on the
`nicotind` service in the same overlay. No `depends_on` in either direction: when the
separator is down the API falls back to the basic filter.

Image: `python:3.11-slim` + ffmpeg + the checkpoint baked at build with SHA-256
verification (204 MB) + torch cu126 + `bs-roformer==0.4.1`. Published per release tag by
the `docker-separator` job in `deploy.yml` (a copy of `docker-analysis`: amd64 only,
`version`/`major`/`release` tags, GHA layer cache scoped `separator-linux-amd64`); the
deploy job `needs:` it and its result is in the deploy `if:` like the other sidecars. CI's
`separator` job runs ruff + pytest with the dev extras only (no torch); the image smoke
build fires when `packages/separator/{Dockerfile,pyproject.toml,requirements-*.txt}` or the
workflows change (the #880 filter, extended), with `GPU=1` so the cu126 install and the
Pascal guard are exercised before a tag ever reaches the deploy job.

Runtime env: `SEPARATOR_IDLE_RELEASE_SEC` (900), `SEPARATOR_MAX_TRACK_SEC` (900),
`SEPARATOR_ALLOW_CPU` (unset), `MUSIC_DIR`, `SEPARATOR_MODELS_DIR` (`/models`).

## Measured

| What | Value | Where |
| --- | --- | --- |
| RTF, Quadro P4000, fp32, 21.77 s chunks, no overlap | **0.261×** (5.68 s per chunk) | spike §5, 2026-08-20 |
| VRAM during a job | 3,029 MiB total-used (torch peak alloc 2,082) | spike §5 |
| Co-tenancy | analysis sidecar 2,235 MiB (after #605) + separator ≈ 5.3 GB of 8,192 | spike §5 |
| CPU-only RTF | 4.1× (~14 min per 3.5-min song) → NO-GO | spike §5 |
| Band energy kept vs. center-cancel, sub-bass | −1.60 dB vs −9.35 dB | spike §3 |

**Measured on kpc with this image (2026-09-02, `docker build --build-arg GPU=1` from this
tree, a real 59.2 s library track, `SEPARATOR_IDLE_RELEASE_SEC=45`):**

| What | Value |
| --- | --- |
| Image | 4.2 GB (torch 2.13.0+cu126 + CUDA wheels + 204 MB checkpoint); build-time strict load prints `checkpoint ok: 51 M params` |
| `/health` at boot | `status: ok, device: cuda, gpu: Quadro P4000, loaded: false` |
| First `/separate` (cold: worker spawn + checkpoint load + inference) | **22.2 s** for 59.2 s of audio — 0.375× all-in |
| After idle release, second call (cold again) | **20.3 s** — so the cold start is ~3–5 s, not the 10 s first estimated |
| Output | 2.69 MB FLAC, 59.178 s vs 59.208 s source (−30 ms, inside the 1 s duration check) |
| VRAM during the job | separator process **2,944 MiB**; card total 5,179 MiB with the analysis sidecar's 2,150 MiB |
| VRAM after idle release | card back to **2,235 MiB** — the separator process is gone, the CUDA context with it |
| `/health` after idle release | `status: ok, loaded: false` (cold, still `ok` — the #539 contract) |

The first attempt on the host also found a real defect the unit tests could not: the model
returns `floor(n / hop) × hop` samples per chunk (865,792 for an 866,156-sample window), which
broke the overlap-add with a shape mismatch → `pad_to_multiple` / `fit_length` in
`app/chunking.py`, both tested. The RTF *warm* with the 2 s crossfade is therefore ≈ 0.29
(the 55 s-per-3.5-min figure holds; the first play of a session adds the cold start).
`tests/test_golden.py` prints the RTF for a synthetic mix; run it in the container with
`SEPARATOR_MODELS_DIR=/models pytest tests/test_golden.py -s`.

## API — the stem is a cache variant, and the stream route never waits

`GET /api/stream/:id?vocals=off` **never blocks on the GPU**. Readiness is a `stat`
(`VocalSeparationService.readyStemPath`): when the instrumental FLAC is in
`<dataDir>/stem-cache/` the route serves the transcode cache's **`|stem` variant** — an
encode of that FLAC by the unchanged `transcodeToFile`, keyed on the *original's* identity
(`transcodeCacheKey(..., 'stem')`, `inputPath` says what ffmpeg reads) so the source
path/mtime/size still governs invalidation and the 55 s GPU pass is paid once per track,
never per format/bitrate. Otherwise it serves the **`|novox` basic** center-cancel variant.
The response says which in `x-nicotind-vocals: ml | basic` (for tests and devtools; the web
learns the mode from the status endpoint). A failing stem encode falls back to basic *in the
same request*, and its verdict is remembered against the **stem file**, never the original
(`transcode-failures.ts` keys on whatever path it is given — so the track's plain and basic
transcodes are untouched). No `mode=` query param: the client cannot know whether the FLAC
survived a prune or the sidecar just went down, and an `<audio>` element cannot act on a 409.

**Stem store** (`services/stem-store.ts`): the `waveform-store.ts` recipe — a
content-addressed key (`stemCacheKey`: path + mtime + size + model id + `STEM_VERSION`, so a
model swap is a miss, not a migration), an in-flight map, an atomic tmp+rename write behind
the transcode cache's own `validateTranscodeOutput` (the FLAC's ffprobe duration vs the
*original's* music-metadata duration, 1 s tolerance — a partial body from a dying sidecar can
never sit at the final name), a 1 KiB floor on the hit, and an oldest-first prune over
`STEM_CACHE_BUDGET_BYTES` (1 GiB ≈ 40 tracks; on-demand only, so growth tracks actual karaoke
use). ~25 MB per 3.5-min track.

**Prepare/status** (`routes/vocal-separation.ts`, mounted at `/api/stream` under the existing
auth prefix; any authenticated user — karaoke already is a listener feature):

```
POST /api/stream/:id/stem   idempotent "ensure": enqueue if needed → StemStatus
GET  /api/stream/:id/stem   status only, never enqueues            → StemStatus
StemStatus = { state: 'idle' }
           | { state: 'unavailable'; reason: 'not-configured'|'disabled'|'no-ffmpeg'|'unhealthy'|'busy' }
           | { state: 'queued'; queuePosition; etaSec } | { state: 'preparing'; etaSec }
           | { state: 'ready' } | { state: 'failed'; reason: 'rejected'|'transient'; retryAfterSec? }
```

**Service** (`services/vocal-separation.ts`, `VocalSeparationService`): one FIFO with one
running job — the GPU is one resource and the sidecar serialises anyway — in memory on purpose
(the `MaintenanceService` argument: the cache on disk is the durable part). A second `ensure`
for the same track joins its job; beyond `STEM_QUEUE_MAX` (8) the answer is `busy`. The ETA
(`estimateEtaSec`, pure) is the running job's remainder + everything ahead + this track, all
at `SEPARATION_RTF = 0.261`, plus `SEPARATION_COLD_START_SEC` (5 s, measured) when nothing is
running (the worker may be idle-released). The fetch timeout is `separateTimeoutMs`: ~3× the RTF + 60 s,
floored at 2 min and capped at 15 min. Failures are remembered by kind, mirroring
`transcode-failures.ts`: **rejected** (sidecar 422, or the FLAC failed the duration check)
sticks until the file's identity changes; **transient** (503, timeout, transport) is kept
for `STEM_TRANSIENT_FAILURE_TTL_MS` (60 s) so a dead sidecar is not re-hit on every 2 s
poll, and the client poisons its cached health the same way `AudioFeaturesClient` does.

**Opt-in** (`services/vocal-separation-toggle.ts`): the `acquisition-toggle.ts` shape with
the opposite default — `resolveVocalSeparationEnabled(configured, stored) = configured &&
(stored ?? false)`. `NICOTIND_SEPARATOR_URL` (`config.separator.url`) is the structural
floor an admin cannot lift; the stored `vocal_separation_enabled` row defaults to off.
`GET`/`PUT /api/admin/vocal-separation` → `{ enabled, configurable }` + an audit row;
`GET /api/admin/review` gains `services.separator: { configured, healthy }` beside `analysis`.

## Web — the mute is intent, readiness decides the URL

`VocalSeparationService` (web) is the state machine between the mic toggle, the status
endpoint and the player. `PlayerService.vocalsMuted` keeps meaning "the listener wants vocals
off" (it persists across tracks, #889). Whether a track is *actually* served with
`?vocals=off` right now is `shouldServeVocalsOff(id)`: muted **and** (its stem is `ready`, or
that track cannot get one — `unavailable`/`failed`, or the instance is known to have no
separator). Everything else while muted is **pending**: the original mix keeps playing (owner
decision — never dead air, never a mid-song downgrade) until the stem lands. There is no
separate pending flag: pending *is* "muted but not yet servable", so toggling twice cancels
it and a track change while muted needs no special case.

The player keys its Effect 6b (the in-place `src` swap with the position restored) on the
service's `currentServeVocalsOff()` rather than on the mute flag, so the swap fires both on a
toggle and when the stem lands; every load path (`streamSrc()`) asks the service per track.
Triggers: the current track is prepared when the karaoke overlay opens (mirrored from
`NowPlayingComponent.karaokeFullscreen`, so the panel-switch and hardware-Back exits are
covered) or the mute is on; while muted the next queued track is prepared too, so the wait
usually happens once per session. Polling is every `STEM_POLL_INTERVAL_MS` (2 s) while
`queued|preparing` and the session is active (overlay open or muted); `unavailable`/transient
tracks are re-asked no more often than every 30 s. The overlay's mic button carries
`data-vocal-mode` (`off | pending | ml | basic`) and a caption (`vocal-mute-status`): the ETA
and queue position while pending, "Instrumental (ML)" or "Basic (center-cancel)" once served;
the `aria-label` stays "Unmute vocals" while pending because toggling again *is* the cancel.
A failed separation degrades that track to basic with one toast. Admin: the opt-in row in
**Streaming & media** (read-only with the reason when no sidecar URL is set) and a separator
pill beside the analysis one in **Library processing**.

## Verifying on the GPU host

See the measurements table above and the #603 thread. The e2e stack has no separator, so the
Playwright test covers the basic path (`vocal-mute-status` reads "Basic"); the ML states are
unit-tested (`vocal-separation.service.spec.ts`, `vocal-separation.test.ts`,
`streaming.test.ts` "ML stem vs the basic filter").
