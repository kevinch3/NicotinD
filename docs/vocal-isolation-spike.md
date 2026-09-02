# Spike: replacing the center-cancel vocal mute with real ML separation

**Status:** research spike, 2026-08-20. **Verdict: GO on ML separation with
`anvuew/BS-RoFormer`, on demand and GPU-only (measured RTF 0.261× / 3.0 GB VRAM on the
P4000 — a 3.5 min song is ~55 s of GPU, and progressive separation can start playback in
~6 s); NO-GO on CPU-only (RTF 4.1×); NO-GO on running it inside the existing Essentia
sidecar — ONNX export now completes with a one-line fix but emits a spec-invalid,
pathological graph.** Two bugs found in passing and filed: the shipped filter outputs
digital silence on any mono downmix (#602), and `ANALYSIS_IDLE_RELEASE_SEC` frees models
but not VRAM, pinning 7.6 GB of the 8 GB card (#605 — root-caused to one predictor's batch size and **fixed**: the sidecar now sits at
2,235 MiB, so separator + sidecar co-host on the one card).

Follows [docs/onnx-runtime-spike.md](onnx-runtime-spike.md) (2026-07-15), which
benchmarked Demucs and recommended a separate torch image. This spike re-asks that
question for the **BS-RoFormer** family, which did not exist in usable form then.

All work was throwaway (scratchpad venvs, `~/spike-roformer`) on the **dev laptop
(no GPU, 6 CPU threads, 14 GB RAM)**. No production code, Dockerfile, compose, or
library data was changed.

## Why we asked

The vocal mute shipped in PR #144 is one ffmpeg line —
`packages/api/src/services/transcode.ts:73`:

```ts
const VOCAL_REMOVAL_FILTER = 'pan=stereo|c0=c0-c1|c1=c1-c0';
```

L−R / R−L center cancellation, behind `?vocals=off`, cached as a separate `novox`
transcode entry. It removes anything panned center — which is the lead vocal, but also
the kick, snare and bass. The prompt was a HuggingFace collection
(`StemSplitio/music-source-separation-toolkit-2026`) asking which of its models could
replace it.

## 1. Triage of the collection — licensing decides more than SDR does

| Repo                                                    | License          | Verdict                                                                                                                                                                     |
| ------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **anvuew/BS-RoFormer**                                  | **GPL-3.0**      | **The candidate.** 51.0 M params, 204 MB ckpt, `num_stems: 1` (vocals only — exactly our use case). GPL-3.0 combines into our AGPL-3.0-only.                                |
| HiDolen/Mini-BS-RoFormer-V2-46.8M                       | **CC-BY-NC-4.0** | **Rejected on license.** Non-commercial is not an OSI-free license; a default-path dependency on it would make the distribution non-free. Vocal SDR 10.86 (MUSDB18-HQ val). |
| Politrees/UVR_resources                                 | MIT              | Fallback pool. Broad UVR mirror (mdx-net, mdx23c, roformer, scnet, bandit). MIT is the cleanest license of the three.                                                       |
| anvuew/dereverb_bs_roformer                             | GPL-3.0          | Not a replacement — a post-stage, only relevant if we ever expose the vocal stem.                                                                                           |
| csukuangfj/spleeter-torch                               | —                | No. 2019 baseline, strictly dominated.                                                                                                                                      |
| mlx-community/demucs-mlx                                | —                | No. Apple-Silicon only; the deploy host is Linux/NVIDIA.                                                                                                                    |
| Eddycrack864/…-Training, StemSplitio HT-Demucs variants | —                | Training scripts / the Demucs the previous spike already benchmarked. Nothing new.                                                                                          |

**The size premise in the collection's framing is wrong for our purposes.** The "Mini"
variant is sold as the compact option, but `anvuew/BS-RoFormer` is `dim: 256, depth: 12`
= **51.0 M params** — within 10 % of the 46.8 M "Mini", at a higher SDR, under a license
we can actually use. There is no size/license trade-off to make here.

## 2. ONNX export: still no, but the blocker is now one line

The previous spike's headline blocker was that `htdemucs` cannot export
(`"STFT does not currently support complex types"`). Re-run against BS-RoFormer
(`bs-roformer==1.2.4`, `torch==2.13.0+cpu`, random weights — export is
weight-independent):

| Exporter                                                 | Result                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `torch.onnx.export(..., dynamo=False, opset_version=17)` | **FAILS** — `SymbolicValueError: STFT does not currently support complex types`. _Byte-identical to the Demucs failure._                                                                                                      |
| `torch.onnx.export(..., dynamo=True, opset_version=18)`  | **FAILS**, but much further along: `torch.export` ✅ → decompositions ✅ → ONNX translation ❌ with a single `DispatchError: No ONNX function found for aten.pad. No decompositions registered for the complex-valued input`. |

The dynamo exporter handles the STFT/iSTFT themselves. The **only** reported blocker is
`F.pad` on a complex tensor — `bs_roformer/bs_roformer.py:533`, the frequency-range
re-pad before `istft`:

```python
stft_repr = F.pad(stft_repr, (0, 0, *self.freq_pad))   # stft_repr is complex here
```

That is trivially expressible in real-view space (pad `view_as_real`, then
`view_as_complex`). **This is a materially different situation from Demucs** — Demucs
needed a whole real-valued STFT reimplementation; BS-RoFormer needs one padding call
rewritten upstream (or monkeypatched at load time).

### The pad fix works — and then the graph does not load

Patching `F.pad` to operate in real-view space (pad `view_as_real`, then
`view_as_complex`) **clears the export**: `torch.export` → decompositions → ONNX
translation → optimize, all ✅, producing a `patched.onnx`. Demucs never got this far.

But the artifact **onnxruntime refuses to load**:

```
InvalidGraph: Type Error: Type 'tensor(int32)' of input parameter (val_2616)
of operator (ScatterND) in node (node_ScatterND_2620) is invalid.
```

Inspecting the graph explains both that error and the 23-minute export — for a **toy
1-layer, dim-64** configuration:

|                                   |                       |
| --------------------------------- | --------------------- |
| total nodes                       | 9,791                 |
| `ScatterND`                       | **2,049**             |
| `Expand` / `Transpose` / `Gather` | 2,137 / 2,079 / 2,053 |
| `MatMul` (the actual maths)       | 200                   |

The band-split/merge is unrolling into thousands of scatter/gather ops rather than
staying vectorised, and the exporter emits their indices as `int32`, which the ONNX spec
forbids for `ScatterND`. Casting the **2,048** constant-initializer index tensors to
`int64` is mechanical (done, one line); the remaining one is a _computed_ tensor and
needs an inserted `Cast` node.

**Verdict:** option (A) from the previous spike — one ONNX runtime for analysis _and_
separation — stays closed, but the reason has changed from _architecturally impossible_
(Demucs' complex STFT) to _the exporter emits a pathological, spec-invalid graph_. That is
repairable with graph surgery and/or upstream fixes, but a 9,791-node graph for one toy
layer is a warning about the eventual ONNX runtime performance too, and none of this was
measured against the real dim-256/depth-12 model. **Do not treat "BS-RoFormer exports to
ONNX" as a green light without re-running this at the real config and measuring ORT
throughput.**

## 3. Quality: measured against the shipped filter

Real checkpoint (`bs_roformer_ft1_anvuew_sdr_12.55.ckpt`), real track, 30 s excerpt,
compared against the exact ffmpeg filter we ship today.

**Per-channel band energy retained vs. the original mix** (0 dB = untouched; the
instrumental _should_ only lose the vocal):

| band                 | BS-RoFormer  | center-cancel (shipped) |
| -------------------- | ------------ | ----------------------- |
| sub/bass 20–250 Hz   | **−1.60 dB** | **−9.35 dB**            |
| low-mid 250 Hz–2 kHz | −3.21 dB     | −9.78 dB                |
| presence 2–6 kHz     | −1.32 dB     | −5.97 dB                |
| air 6–16 kHz         | −4.61 dB     | −9.20 dB                |

The shipped filter removes **9.35 dB of sub-bass** — the bass guitar and kick drum,
which have nothing to do with the vocal. That is the "rustic" complaint, quantified.
BS-RoFormer leaves the low end essentially intact (−1.60 dB) and takes its energy out of
the low-mid/presence bands where the voice actually lives.

## 4. Bug found in passing: karaoke mode is **silent in mono**

`c0 = L−R` and `c1 = R−L = −(L−R)` are, by construction, perfectly anti-phase. Measured
on the filter's real output:

```
center-cancel L/R correlation: -1.000000
  original mix           stereo -19.14 dBFS   mono-sum  -19.26 dBFS
  roformer instrumental  stereo -21.47 dBFS   mono-sum  -21.64 dBFS
  center-cancel          stereo -28.56 dBFS   mono-sum -120.00 dBFS   <-- digital silence
```

Any mono downmix of `?vocals=off` output is **exactly zero**: phone speakers, mono
Bluetooth headsets/earbuds worn singly, mono TV output. Karaoke on a phone speaker — a
plausible primary use case — plays nothing at all. This is independent of the separation
question and fixable today by summing to a mono-safe result instead of an anti-phase
pair. **Filed separately; it should not wait on this spike.**

**Fixed 2026-09-02 (#602):** both channels are now `0.5*(L−R)` — identical, so the mono sum is
the side signal instead of zero; the `0.5` is measured (L−R peaked at +0.7 to +5.2 dBFS on 6 of 7
random prod tracks, which the encoder clips). Pinned by `transcode.vocal-mute.test.ts`.

## 5. Runtime: the deployment constraint

Dev laptop, CPU-only, 6 threads, `bs-roformer==0.4.1`, 21.8 s chunks (the config's
`chunk_size: 960000`):

- **~90 s per 21.8 s chunk → real-time factor ≈ 4.1×** (a 5.9× figure was also measured
  while the ONNX export job contended for the same cores; 4.1× is the uncontended
  per-chunk number).
- **Peak RSS 2,752 MB.**

So a 3.5-minute song costs **~14 minutes of CPU** and ~2.7 GB RAM. Consequences:

- **On-demand separation at first karaoke play is not viable CPU-only.** It is only
  viable on a GPU.
- **GPU (measured on `kpc`, Quadro P4000, torch 2.4.1+cu121, 2026-08-20):**
  **RTF 0.261×** — mean 5.68 s per 21.77 s chunk over 4 chunks (5.66 / 5.66 / 5.68 /
  5.73 s; the spread is negligible). **A 3.5-minute song ≈ 55 s of GPU.** VRAM: torch peak
  alloc **2,082 MiB**, reserved 2,836 MiB, `nvidia-smi` total-used **3,029 MiB**.
  For reference the previous spike measured Demucs at RTF 0.10 / ~2.7 GB — BS-RoFormer is
  ~2.6× slower at comparable VRAM, buying the quality in §3.
- **Pascal (cc 6.1) constrains the stack**: CUDA 13 / current torch builds drop `sm_61`, so
  this must be pinned to a cu121-era torch (2.4.1 here), exactly as the previous spike
  found. That pin is a deployment fact, not a preference.
  _Corrected 2026-09-02:_ the drop is specific to PyTorch's **CUDA 12.8+** wheels (torch
  2.8 onward); the **cu126** wheels stay as the legacy lane and carry Pascal `sm_60` kernels
  through torch 2.13 (SASS is forward-compatible within a major, so the cc 6.1 card runs them —
  there is no `sm_61` entry), and the prod driver (580) runs them. The shipped image pins
  `torch==2.13.0+cu126` and asserts the arch at build — see
  [vocal-separation.md](vocal-separation.md).
- **The card had no room — now it does (issue #605, fixed).** Measured on `kpc`: the
  sidecar reported `{"loaded": false}` (idle release _had_ fired) while still holding
  **7,626 MiB of 8,192 MiB at 0 % utilisation**. Root-causing that turned out to be the
  unlock for this whole feature: it was not TF's allocator being unfixable, it was
  `TensorflowPredictMusiCNN` allocating ~5.4 GB for a 216×200 array. Bounding its
  `batchSize` to 4 takes the sidecar to **2,235 MiB**, bit-identical output, and slightly
  faster. **The separator's 3,029 MiB + the sidecar's 2,235 MiB = 5.3 GB of 8.2 GB — they
  co-host with ~2.9 GB to spare.** Note Ollama (~2.7 GB) makes it three-way tight; that is
  a scheduling question, not a blocker.
- **`TF_GPU_ALLOCATOR=cuda_malloc_async` is not an option** — measured, it segfaults the
  sidecar at boot on this TF 2.5 / CUDA 11 / Pascal combination.

## 6. Architecture

Separation is **not** a streaming filter. Every model here needs the whole track (or
21.8 s chunks with overlap), so `?vocals=off` stops being an ffmpeg `-af` and becomes a
separated stem produced ahead of playback. The existing `novox` transcode-cache entry is
the slot it drops into, with its size-in-key/negative-cache integrity rules already in
place (docs/library-scanner.md "Transcode cache integrity").

### Decided: opt-in, on demand, no precompute

**Owner decision, 2026-08-20.** Separation runs **on demand, at first karaoke play**,
behind an **opt-in** setting. There is **no library precompute** — no nightly enrichment
task, no "precompute the liked songs" tier. The `novox` cache still caches the result
after the first separation; that is caching, not precomputation, and the distinction is
the point: work happens only for a track someone actually asked to sing to.

Rejected alternatives and why: a nightly enrichment task would spend many GPU-hours
separating a library that is overwhelmingly never sung to; a hybrid (precompute
liked/recently-played) buys latency on a minority of tracks while carrying the whole
cost and complexity of the batch tier.

Consequences that follow from this shape and need designing:

- **The feature is GPU-gated.** CPU-only is RTF ≈ 4.1× (§5), so on-demand separation on a
  CPU box would make the user wait ~14 minutes. A deployment without a usable GPU must
  either hide the toggle or keep the center-cancel filter as an explicitly labelled
  degraded mode — it must not silently take the 14-minute path.
- **First play needs a real "preparing" state** — but it need not be a 55-second one. At
  RTF 0.261 separation runs ~3.8× faster than playback, so a **progressive** design
  (separate chunk _n+1_ while chunk _n_ plays) can start audio after the **first ~5.7 s
  chunk** and stay comfortably ahead of the playhead for the rest of the track. That turns
  the decided on-demand shape from "wait ~55 s" into "wait ~6 s", and it is the single
  biggest UX lever in this design. It does require the stem to be written incrementally
  into the `novox` cache entry, with a partial entry never being mistaken for a complete
  one — the same integrity discipline the transcode cache already applies via
  size-in-key.
- **Opt-in means a setting that also reflects availability** — the `configured && healthy`
  pattern the analysis sidecar already uses on `GET /api/admin/review`, not preference
  alone.
- **It is a foreground request against a contended GPU.** Unlike enrichment it cannot
  wait, and it interacts directly with #605 (the sidecar pinning 7.6 GB while idle).
  (Enrichment's automatic `gpuBusyPercent` yield has since been removed — it measured as
  a no-op — leaving `paused` as the manual stand-down.)

Model-code sourcing is a real maintenance note: the anvuew checkpoint is trained against
**ZFTurbo's fork** of `bs_roformer`, not upstream — its config carries fork-only keys
(`linear_transformer_depth`, `use_torch_checkpoint`, `mlp_expansion_factor`,
`skip_connection`). All of them are falsy-or-default here, so after dropping them
**`bs-roformer==0.4.1` (upstream lucidrains) loads the checkpoint with 0 missing / 0
unexpected keys** — verified. Pin that version; later releases (0.6.1 → 1.2.4) changed
the block layout (hyper-connections) and mismatch 620–668 tensors.

## 7. If you come back to this: how to resume

Anchors in the tree: `packages/api/src/services/transcode.ts:73` (`VOCAL_REMOVAL_FILTER`,
the thing being replaced) and `:115` (the `-af` call site);
`packages/api/src/services/transcode-cache.ts` (the `novox` entry that becomes the stem
slot); `packages/analysis/` (the FastAPI skeleton a separator sidecar would mirror, per
the previous spike's option B).

Environment used (throwaway venvs, Python 3.14):

```bash
python -m venv v  && v/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
v/bin/pip install onnx onnxruntime onnxscript soundfile numpy librosa einops \
                  rotary-embedding-torch beartype huggingface_hub
v/bin/pip install bs-roformer          # 1.2.4, for the ONNX export attempt
# separate venv for inference — the checkpoint needs the OLD architecture:
v2/bin/pip install bs-roformer==0.4.1
```

Checkpoint + config:
`huggingface_hub.hf_hub_download('anvuew/BS-RoFormer', 'bs_roformer_ft1_anvuew_sdr_12.55.ckpt')`
and `config.yaml` from the same repo — it uses `!!python/tuple`, which one constructor on
`yaml.SafeLoader` covers (no `UnsafeLoader` needed), and the `model` block must be
filtered to the keys `BSRoformer.__init__` actually accepts. Both live in
`packages/separator/app/model_config.py` now.

**The GPU measurement is done** (§5). It was run on `kpc` like this — note the card must
be freed first, because the analysis sidecar pins it even when idle (#605):

```bash
docker restart nicotind-analysis-1          # ONLY way to release the 7.6 GB; verify with nvidia-smi
docker run --rm --gpus all -v /tmp:/w -v /mnt/data1tb_new/music:/music:ro -w /w \
  pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime \
  bash -lc "pip -q install bs-roformer==0.4.1 pyyaml numpy;
            apt-get -qq update && apt-get -qq install -y ffmpeg;
            python /w/gpu_bench.py '/music/<artist>/<album>/<track>.mp3' 90"
```

`gpu_bench.py` warms up one chunk (CUDA context + autotune) before timing, and reports
`torch.cuda.max_memory_allocated` alongside the `nvidia-smi` total so the allocator's
reserve is visible separately from the model's own footprint.

**Second task — close the ONNX question.** Apply the real-view pad fix at
`bs_roformer.py:533` and re-run the dynamo export; if it completes and
`onnxruntime` output matches torch, option (A) from the previous spike (one ONNX runtime
for analysis _and_ separation) becomes live again and should be re-costed against the
mel-parity work that blocked it.

### The export attempts, verbatim

```python
import torch
from bs_roformer import BSRoformer
m = BSRoformer(dim=64, depth=1, stereo=True, num_stems=1,
               time_transformer_depth=1, freq_transformer_depth=1, flash_attn=False).eval()
x = torch.randn(1, 2, 2*44100)
torch.onnx.export(m, (x,), "a.onnx", dynamo=False, opset_version=17)
#   -> SymbolicValueError: STFT does not currently support complex types   (same as Demucs)
torch.onnx.export(m, (x,), "b.onnx", dynamo=True, opset_version=18)
#   -> ConversionError / DispatchError: No ONNX function found for aten.pad
#      "No decompositions registered for the complex-valued input"         (one line, patchable)
```
