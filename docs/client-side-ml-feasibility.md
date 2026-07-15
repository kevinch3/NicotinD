# Feasibility: client-side (browser + Capacitor) vocal mute & audio analysis

**Status:** feasibility analysis, 2026-07-15. **Verdict: NO-GO for moving analysis to
the browser; NO-GO for client-side ML vocal isolation; the only cheap client-side win
(Web-Audio center-cancel) is blocked on the exact platform that motivates it (Android
WebView).** Keep both workloads server-side. One genuinely additive client-side idea
(audio-reactive visuals) is noted at the end.

This is an analysis grounded in the current code, not an executed spike. It answers:
*can browser ML (WebGPU / WebNN / onnxruntime-web) or Capacitor native acceleration
(Core ML / NNAPI) do the vocal mute or the audio analysis on the client?*

## First, separate two workloads that get conflated

| | **Vocal mute (karaoke)** | **Audio analysis / enrichment** |
|---|---|---|
| Nature | real-time DSP on the *currently playing* stream | offline **batch** over the *whole library* (thousands of files) |
| Today | server ffmpeg center-cancel (`pan=…c0-c1`), `?vocals=off`, cached | Essentia + TF sidecar, nightly window, writes **DB + file tags** |
| Output | audio bytes, must seek instantly | canonical rows (embeddings, BPM, mood…) other features score against |
| "Browser LLM" fit | not an LLM; it's a 2-line DSP or a heavy separation net | not an LLM; Essentia DSP + small classifier heads |

Neither is an "LLM" workload. The browser-ML ecosystem the question gestures at
(WebGPU, WebNN, onnxruntime-web, Transformers.js, WebLLM) is real and maturing, but
what NicotinD runs is DSP + small nets, so the relevant client tech is
**onnxruntime-web / essentia.js (WASM) / Web Audio**, not an LLM runtime.

## Vocal mute on the client

**Cheap path — Web Audio center-cancel (no ML).** The server filter is just
L−R / R−L; a `ChannelSplitter → invert → merge` graph reproduces it in the browser for
free, and toggling would be *instant and position-stable* (no re-fetch of a second
transcoded file, no bandwidth). Attractive on paper.

**Why it's blocked today:** the team already tried exactly this. Routing the `<audio>`
element through a `MediaElementAudioSourceNode` **silenced playback entirely on Android
WebView** — see the load-bearing comment at
`packages/web/src/app/components/player/player.component.ts:309-312`
("Do not reintroduce a client-side vocal filter"). Android WebView is the **Capacitor
runtime** — i.e. the very "mobile" target the question wants to accelerate. So the cheap
client path fails precisely where it would matter most. Secondary friction: the
`/api/stream` element would need `crossorigin` + CORS coordination with the hand-rolled
`nativeAppCors()` + Range handling.

**ML path — real vocal isolation (Demucs / MDX-Net) in-browser:** not feasible for
streaming. Per [docs/onnx-runtime-spike.md](onnx-runtime-spike.md), Demucs won't even
ONNX-export (complex-STFT), and an MDX-Net-class separator is a hundreds-of-MB model
doing full-track STFT — you cannot run it low-latency, seekably, on a live stream in a
browser tab (let alone a phone WebView on battery). Real ML separation belongs
server-side, exactly where the spike put it.

**Verdict:** keep server-side. The current `?vocals=off` transcode-cache design is the
right call. Only revisit the Web-Audio path if the Android-WebView-silence bug is ever
resolved *and* you accept desktop-only behavior — low value.

## Audio analysis on the client

**Can the models run in a browser?** Technically yes, and better than you'd guess:
- Essentia publishes every neural model as **ONNX** (spike finding) → runs under
  `onnxruntime-web` with the **WebGPU** backend on current Chrome/Edge/Safari 18+.
- **essentia.js** is a real WASM build of Essentia — it can do `RhythmExtractor2013`
  (BPM) and the `TensorflowInput*` mel front-ends *by construction* in the browser,
  which is the one thing that dodges the spike's mel-parity wall (hand-rolled mel only
  reached 0.58 cosine vs the ≥0.999 needed).

**Why it's still the wrong home — architecture, not capability:**
1. **It's server-canonical batch data.** Enrichment backfills the *whole library* into
   SQLite + **file tags**, resumably, in a nightly window (`ENRICHMENT_TASKS`). A
   browser can't write file tags and can't own thousands of tracks it never plays.
2. **Whose browser?** Only online users would contribute; results would vary by device
   and need per-client re-validation. Embeddings drive radio cosine-similarity — they
   must be produced by **one** consistent pipeline or they're incomparable (the exact
   failure mode the spike's ≥0.999 gate guards against).
3. **No efficiency win.** The work is already done once, server-side, off the hot path.
   Moving it client-side adds coordination, parity risk, and a re-analysis, for nothing.

The *only* coherent client-side analysis use is analyzing the **one track currently
playing** for a live feature (below) — never library backfill.

**Verdict:** NO-GO. Analysis stays a server-owned batch job.

## Capacitor / mobile native acceleration (Core ML / NNAPI)

The premise ("GPU not being used, it's on CPU") is about on-device accelerators — Apple
**Neural Engine** via Core ML, Android **NNAPI** / GPU delegate. Two facts:

- **JS/WebView can't reach the NPU.** You'd need a **native plugin** (Swift Core ML /
  Kotlin NNAPI, or ONNX Runtime Mobile with the CoreML/NNAPI execution providers),
  in the mold of the existing `@nicotind/capacitor-now-playing` Swift plugin. Real work,
  per-platform, per-model.
- **There's no on-device workload worth it.** Vocal mute → server (and its cheap client
  form is WebView-blocked); analysis → server batch. Native acceleration here is a
  solution in search of a workload. If a future feature genuinely needs on-device
  inference (e.g. offline analysis of side-loaded files), ONNX Runtime Mobile's
  CoreML/NNAPI EPs are the correct door — but nothing today asks for it.

## The one client-side idea that *is* additive

**Audio-reactive visuals / live meters** via `AnalyserNode` FFT on the playing stream:
zero server cost, no parity concerns, no file-tag writes, purely cosmetic, works on
desktop. (Note it may hit the same Android-WebView `MediaElementAudioSourceNode` issue —
verify on-device before committing, since that node is what broke vocal mute.) This is
the honest client-side opportunity — a *visualization*, not offloaded ML.

## Bottom line

- **Vocal mute:** stays server-side. Client center-cancel is cheap but Android-WebView-
  blocked (`player.component.ts:309`); client ML separation is infeasible for streaming.
- **Analysis:** stays a server-side batch job. Browser can *run* the models
  (onnxruntime-web/WebGPU, essentia.js) but it's the wrong owner for canonical, tag-
  writing, whole-library enrichment.
- **Capacitor native accel (Core ML/NNAPI):** possible via a native plugin, but there is
  no on-device workload that justifies it today.
- **Do instead (if you want a client feature):** an `AnalyserNode` visualization —
  additive, free, no ML offload — after confirming it survives Android WebView.

See also [docs/onnx-runtime-spike.md](onnx-runtime-spike.md) (server-side ML unification
verdict) and the vocal-mute implementation in
`packages/api/src/services/transcode.ts` + `player.component.ts`.
