# Spike: can audio analysis + voice isolation share one ONNX Runtime stack?

**Status:** research spike, 2026-07-15. **Verdict: NO-GO on full ONNX unification now;
GO on a shared code module + separate torch-Demucs image.** ONNX unification stays a
documented future option if retiring the pinned TensorFlow 2.5 becomes a priority.

All work below was throwaway (scratchpad venvs) on the prod host (Quadro P4000, 8 GB).
No production code, Dockerfile, compose, or library data was changed.

## Why we asked

The vocal-mute rework (PR #144 shipped an ffmpeg center-cancellation filter) raised the
option of *real* ML vocal isolation. Benchmarking Demucs on the P4000 was cheap
(13.2 s / 133.5 s track, ~2.7 GB VRAM). But Demucs is **PyTorch**, while the analysis
sidecar (`packages/analysis`) is **Essentia + TensorFlow 2.5.0** — an aging, *pinned*
stack wired via a fragile `libtensorflow`-swap hack. Question: rather than run two ML
frameworks, can both run on **one runtime — ONNX Runtime (GPU)** — for a simpler,
single-CUDA-stack architecture?

## What was tested & found

### 1. Separation → ONNX: Demucs does NOT convert
- `torch.onnx.export(htdemucs, …, opset=17)` fails: **"STFT does not currently support
  complex types."** The `dynamo=True` exporter also fails. htdemucs's STFT/iSTFT front-end
  uses complex tensors ONNX can't represent.
- **Implication:** you cannot run *Demucs itself* on ONNX without a custom real-valued STFT
  reimplementation. The practical ONNX separation route is a different model family —
  **MDX-Net-class ONNX models** (the UVR / Ultimate Vocal Remover ecosystem), which are
  natively ONNX and competitive for vocal isolation — but they, too, need the STFT
  front/back-end done in numpy **outside** the graph.

### 2. Analysis → ONNX: models exist, but the front-end is the wall
- **Every neural model in the pipeline is officially published as ONNX** by Essentia:
  `discogs-effnet-bsdynamic-1.onnx` (embedding), `msd-musicnn-1.onnx`,
  `emomusic-msd-musicnn-2.onnx`, `voice_instrumental-…onnx`, `danceability-…onnx`, etc.
  The effnet ONNX loads and runs on onnxruntime (input `melspectrogram[batch,128,96]` →
  `embeddings[batch,1280]`). ✅
- **But the mel front-end is computed *outside* the graph** (by Essentia's
  `TensorflowPredictEffnetDiscogs`), and reproducing it to parity is non-trivial. Measured
  against the **live TF sidecar's embedding** for a real track (cosine target ≥ 0.999 so
  stored library embeddings stay comparable):

  | Front-end reproduction attempt | cosine vs live sidecar |
  |---|---|
  | 128 mel × 96 frames, log10(mel+1) | 0.30 |
  | best of an 8-config sweep (96 mel × 128 frames, log10) | **0.58** |

  Naive reproduction produces **incomparable** embeddings. Getting the exact Essentia mel
  (filterbank/normalization/log/patching) right is real DSP work; a mismatch would force a
  **one-time full-library re-analysis** (embeddings drive radio cosine-similarity; features
  drive scoring).

### 3. BPM has no ONNX form
`/rhythm` uses Essentia's **`RhythmExtractor2013`** — a classical DSP algorithm, not a
neural net. There is no ONNX equivalent, so **plain `essentia` must stay** for BPM
regardless of what happens to the neural models.

### 4. The good news hiding in (2)+(3)
Plain **`essentia`** (no TensorFlow) `pip install`s in seconds — none of the fragile
`libtensorflow`-swap hack. It provides the DSP (mel front-ends via `TensorflowInputMusiCNN`
et al. **exactly by construction**, plus `RhythmExtractor2013`). So the *fragile* part is
specifically **essentia-tensorflow**, and that is retireable.

## The two architectures

**(A) Full ONNX unification** — `essentia` (DSP: mel front-ends + BPM) + `onnxruntime-gpu`
(all neural inference: analysis heads/embeddings **and** MDX-Net separation). One GPU
inference runtime, no TensorFlow, retires the `libtensorflow` hack.
- **Cost:** reproduce/validate the mel front-ends to parity **using Essentia's own input
  algorithms** (not hand-rolled — see the 0.58 above) or accept a one-time re-analysis;
  **and give up Demucs specifically** for an MDX-Net-class separator.

**(B) Shared module, two images (recommended now)** — keep the working, validated
essentia-tensorflow analysis untouched; add separation as a **separate torch-Demucs image**
that shares the `packages/analysis` FastAPI skeleton, `/health`, path resolution, device
probe, and the bun-side client/task conventions.
- **Cost:** two ML frameworks, but isolated in separate containers (each brings its own
  CUDA; no in-process conflict). Best separation quality (Demucs). Zero risk to stored data.

## Recommendation

**Go with (B) now.** The elegance the user wants (one runtime) is real but its cost is
concentrated in (i) exact mel-parity work + possible library re-analysis and (ii) trading
Demucs for MDX-Net — not worth it today versus keeping the validated analysis stack and
getting best-quality Demucs separation behind a clean shared module.

**Keep (A) as a documented migration target** for *when* the TF 2.5 pin finally forces a
move: the path is proven (Essentia ships every model as ONNX; plain `essentia` covers the
DSP), and the scoped cost is the mel-parity work + a one-time re-analysis + switching the
separator to MDX-Net.

## VRAM / runtime notes (P4000, 8 GB)
- Measured residents: essentia-tensorflow ~4.3 GB; torch Demucs ~2.7 GB; ollama ~2.7 GB.
  Any two of these coexist; **all three do not** — the real operational constraint on this
  card, independent of framework choice (VRAM is model-bound, not framework-bound).
- An `onnxruntime-gpu` image is smaller than the TF 2.5 + CUDA-11 stack, but unification
  buys **no runtime efficiency** — it's a maintenance/elegance play (one inference engine,
  drop the pinned TF), not a speed or VRAM win.

## If you come back to this: how to resume

Anchors in the tree: `packages/analysis/app/models.py` (`EssentiaRegistry` — the mel
front-end to reproduce + `runtime_device()` driver probe, framework-agnostic),
`packages/analysis/app/features.py` (`derive_features`), `packages/analysis/Dockerfile`
(the `libtensorflow`-swap hack to retire), `packages/api/src/services/audio-features-client.ts`
(the HTTP contract to preserve). The plan lives at `~/.claude/plans/cheeky-greeting-sedgewick.md`.

Environment used (throwaway venv): `python -m venv v && v/bin/pip install
'torch==2.4.1' 'torchaudio==2.4.1' --index-url https://download.pytorch.org/whl/cu121`
then `v/bin/pip install demucs onnx onnxruntime essentia 'numpy<2' soundfile`. The Essentia
ONNX models are at `https://essentia.upf.edu/models/...` (effnet is the **`-bsdynamic-1.onnx`**
variant — the `-bs64-1.onnx` name 404s). The live sidecar for a parity reference:
`POST http://<analysis-container-ip>:8000/analyze {"relPath": "<rel path under /data/music>"}`.

### Demucs → ONNX export (fails on complex STFT — records the blocker)
```python
import torch; from demucs.pretrained import get_model
m = get_model('htdemucs').models[0].eval()
n = m.valid_length(int(round(m.segment*m.samplerate)))
torch.onnx.export(m, (torch.randn(1,2,n),), "htdemucs.onnx", opset_version=17)  # -> "STFT does not support complex types"
# torch.onnx.export(..., dynamo=True) also fails.
```

### Analysis parity sweep (best naive config only reached cosine 0.58 vs the live sidecar)
```python
import warnings, json, subprocess, numpy as np
warnings.filterwarnings("ignore")
import essentia.standard as es, onnxruntime as ort
SR = 16000
def load(p):
    r = subprocess.run(["ffmpeg","-hide_banner","-loglevel","error","-i",p,"-vn","-ac","1",
                        "-ar",str(SR),"-f","f32le","pipe:1"], capture_output=True)
    return np.frombuffer(r.stdout, dtype=np.float32).copy()
audio = load("track1.mp3")                                     # any local stereo file
ref = np.array(json.load(open("ref_analyze.json"))["embedding"]["values"], np.float32)  # from live sidecar
sess = ort.InferenceSession("effnet.onnx", providers=["CPUExecutionProvider"])
iname = sess.get_inputs()[0].name
cos = lambda e: float(np.dot(e,ref)/(np.linalg.norm(e)*np.linalg.norm(ref)+1e-9))
def melframes(bands):
    spec=es.Spectrum(size=512); w=es.Windowing(type='hann',size=512,zeroPhase=True,normalized=False)
    mb=es.MelBands(numberBands=bands,sampleRate=SR,lowFrequencyBound=0,highFrequencyBound=8000,
                   warpingFormula='slaneyMel',weighting='linear',normalize='unit_tri',type='power',log=False)
    return np.array([mb(spec(w(fr))) for fr in es.FrameGenerator(audio,frameSize=512,hopSize=256,startFromZero=True)], np.float32)
# swept: bands ∈ {128 (mel-first, 96-frame patch), 96 (time-first, 128-frame patch)} × log ∈ {log10(x+1), ln, dB, none}
# BEST: bands=96, time-first patch [n,128,96], log10(mel+1) -> cosine 0.58. Need >=0.999.
# => must use Essentia's OWN input algorithm (e.g. TensorflowInputMusiCNN), not a hand-rolled mel.
```
**Next step if resumed:** stop hand-rolling the mel — drive it from Essentia's exact input
algorithm so parity is correct by construction, then re-measure cosine on ~20 real tracks.
If it can't hit ≥0.999, budget a one-time full-library re-analysis.
