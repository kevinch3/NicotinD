"""Chunked inference windows and the crossfaded overlap-add that joins them.

BS-RoFormer runs on fixed-length chunks (the checkpoint's `audio.chunk_size`,
960,000 samples = 21.77 s at 44.1 kHz — the unit the RTF was measured in).
Consecutive windows overlap by `OVERLAP_SAMPLES` and are joined with
complementary linear ramps, so a chunk boundary never lands as a click or a
model-edge artefact in the instrumental.

Why 2 s of overlap and not the config's `inference.num_overlap: 4`: that
setting re-predicts every sample four times (step = chunk / 4) and averages —
a quality refinement that would quadruple the measured RTF 0.261 to ~1.0, i.e.
slower than playback. A 2 s crossfade costs ~10 % (step 19.77 s instead of
21.77 s) and hides the boundary, which is what karaoke needs.
"""

from __future__ import annotations

import numpy as np

CHUNK_SAMPLES = 960_000
OVERLAP_SAMPLES = 88_200  # 2 s at 44.1 kHz


def chunk_windows(
    n_samples: int, chunk: int = CHUNK_SAMPLES, overlap: int = OVERLAP_SAMPLES
) -> list[tuple[int, int]]:
    """`[(start, end)]` windows covering `[0, n_samples)`; neighbours overlap by
    exactly `overlap`. The last window may be short, but is always longer than
    the overlap it has to crossfade over (it starts one step after a window
    that did not reach the end)."""
    if n_samples <= 0:
        return []
    if chunk <= overlap:
        raise ValueError("chunk must be longer than the overlap")
    step = chunk - overlap
    windows: list[tuple[int, int]] = []
    start = 0
    while True:
        end = min(start + chunk, n_samples)
        windows.append((start, end))
        if end >= n_samples:
            return windows
        start += step


def crossfade_weights(length: int, overlap: int, *, fade_in: bool, fade_out: bool) -> np.ndarray:
    """Per-sample weights for one window: a linear ramp up over the first
    `overlap` samples (unless it is the first window) and down over the last
    (unless it is the last). Ramps are sampled at half-steps so a fade-out and
    the next window's fade-in sum to exactly 1 at every sample."""
    weights = np.ones(length, dtype=np.float32)
    if overlap <= 0 or length <= 0:
        return weights
    ramp = (np.arange(overlap, dtype=np.float32) + 0.5) / overlap
    k = min(overlap, length)
    if fade_in:
        weights[:k] = ramp[:k]
    if fade_out:
        weights[length - k :] = (1.0 - ramp)[:k]
    return weights


def overlap_add(
    pieces: list[np.ndarray], windows: list[tuple[int, int]], n_samples: int, overlap: int
) -> np.ndarray:
    """Join `(channels, length)` pieces predicted on `windows` back into one
    `(channels, n_samples)` signal with crossfaded overlaps."""
    channels = pieces[0].shape[0]
    out = np.zeros((channels, n_samples), dtype=np.float32)
    last = len(windows) - 1
    for i, (piece, (start, end)) in enumerate(zip(pieces, windows)):
        length = end - start
        weights = crossfade_weights(length, overlap, fade_in=i > 0, fade_out=i < last)
        out[:, start:end] += piece[:, :length] * weights
    return out


def pad_to_multiple(chunk: np.ndarray, multiple: int) -> np.ndarray:
    """Zero-pad `(channels, n)` on the right so `n` is a multiple of the STFT
    hop: the model returns `floor(n / hop) * hop` samples, so an unpadded
    chunk comes back short (measured: 865,792 for 866,156 in, hop 512)."""
    n = chunk.shape[1]
    pad = (-n) % multiple
    if pad == 0:
        return chunk
    return np.pad(chunk, ((0, 0), (0, pad)))


def fit_length(piece: np.ndarray, length: int) -> np.ndarray:
    """Trim or zero-pad a model output to exactly `length` samples — the
    window it was predicted for — so overlap-add never sees a shape mismatch."""
    have = piece.shape[1]
    if have == length:
        return piece
    if have > length:
        return piece[:, :length]
    return np.pad(piece, ((0, 0), (0, length - have)))
