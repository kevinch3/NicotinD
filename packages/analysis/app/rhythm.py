"""Tempo (BPM) analysis: the injectable boundary between the HTTP app and
Essentia's RhythmExtractor2013.

Exists because the bun-side detector (music-tempo) makes frequent octave
errors — it locks onto half- or double-tempo agents (a library sample showed
~50% of stored BPMs off by 2x in either direction). RhythmExtractor2013
matched known tempos on every high-confidence spot-check, so the API prefers
this endpoint and keeps music-tempo only as a fallback.

`RhythmAnalyzer` is the protocol the app consumes; `EssentiaRhythmAnalyzer`
is the real implementation (imports essentia lazily, mirroring models.py).
Deliberately independent of the TF model registry: tempo needs no models, so
/rhythm keeps working when the model files are absent.
"""

from __future__ import annotations

import math
import subprocess
import threading
from dataclasses import dataclass, field
from typing import Protocol

# RhythmExtractor2013 is designed for 44.1 kHz input. A 90 s slice is plenty
# to lock a stable tempo (matches the bun-side analyzer's window) and keeps
# the multifeature method fast (~1.3 s/track).
SAMPLE_RATE = 44100
ANALYZE_SECONDS = 90

# --- Candidate-list dials -------------------------------------------------
# Two readings closer together than this are the same tempo, not a second
# opinion: RhythmExtractor2013's per-window estimates jitter by a BPM or two
# around the winner, and showing 152 next to 153.5 is noise, not a choice.
CANDIDATE_TOLERANCE_BPM = 3.0
# Music lives inside this range. A "tempo" outside it is an octave artefact of
# the beat tracker rather than something a listener would ever tap along to.
MIN_PLAUSIBLE_BPM = 40.0
MAX_PLAUSIBLE_BPM = 220.0
# The list is a set of choices, not a search result. Past a handful it stops
# being a decision and becomes a scroll.
MAX_CANDIDATES = 5


def rank_bpm_candidates(primary: float, estimates: list[float]) -> list[float]:
    """Rank the tempos a curator could plausibly mean, best guess first.

    Order is deliberate. The detector's own answer leads, because the curator
    has to recognise what is stored before they can call it wrong. Half and
    double come next: an octave error is the failure this list exists to fix,
    and the extractor's `estimates` almost never contain the other level (they
    are a per-window trace of one locked-on level, so they cluster around the
    winner). Genuinely distinct estimates come last.

    The primary is always kept, even when implausible - hiding it would leave a
    wrong stored value with no visible explanation.
    """
    ordered: list[float] = [round(primary, 1)]

    def offer(value: float, *, clamp: bool = True) -> None:
        if not math.isfinite(value) or value <= 0:
            return
        if clamp and not (MIN_PLAUSIBLE_BPM <= value <= MAX_PLAUSIBLE_BPM):
            return
        value = round(value, 1)
        if any(abs(value - kept) < CANDIDATE_TOLERANCE_BPM for kept in ordered):
            return
        ordered.append(value)

    if math.isfinite(primary) and primary > 0:
        offer(primary / 2)
        offer(primary * 2)
    for estimate in estimates:
        if len(ordered) >= MAX_CANDIDATES:
            break
        offer(estimate)
    return ordered[:MAX_CANDIDATES]


@dataclass
class RhythmResult:
    bpm: float
    confidence: float
    method: str
    # Alternative readings of the same signal, best first, `bpm` included.
    # Empty is never correct: a result always offers at least its own value,
    # so the invariant is enforced here rather than at each construction site.
    candidates: list[float] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.candidates:
            self.candidates = [self.bpm]


class RhythmAnalyzer(Protocol):
    def analyze(self, path: str) -> RhythmResult: ...


def load_audio_44k(path: str):
    """Decode the head of any codec to 44.1 kHz mono float32 via ffmpeg.

    Same rationale as models.load_audio: Essentia's bundled AudioLoader lacks
    Opus support (the library's standard codec), ffmpeg handles everything.
    """
    import numpy as np  # deferred with the rest of the analysis deps

    proc = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-t",
            str(ANALYZE_SECONDS),
            "-i",
            path,
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(SAMPLE_RATE),
            "-f",
            "f32le",
            "pipe:1",
        ],
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg decode failed: {proc.stderr.decode(errors='replace')[:300]}")
    audio = np.frombuffer(proc.stdout, dtype=np.float32)
    if audio.size < SAMPLE_RATE * 5:  # need a few seconds to lock a tempo
        raise RuntimeError("decoded audio too short")
    return audio


class EssentiaRhythmAnalyzer:
    """RhythmExtractor2013 (multifeature) over an ffmpeg-decoded 90 s slice.

    The extractor instance is created per call (it's cheap, unlike the TF
    graphs) but calls are serialized with a lock — Essentia standard-mode
    algorithms are not thread-safe and FastAPI runs sync endpoints in a
    threadpool.
    """

    def __init__(self) -> None:
        # Fail fast at construction when essentia is missing so the app wires
        # a None analyzer and /rhythm 503s instead of 500ing per request.
        import essentia.standard  # type: ignore[import-not-found]  # noqa: F401

        self._lock = threading.Lock()

    def analyze(self, path: str) -> RhythmResult:
        import essentia.standard as es  # type: ignore[import-not-found]

        audio = load_audio_44k(path)
        with self._lock:
            bpm, _beats, confidence, estimates, _intervals = es.RhythmExtractor2013(
                method="multifeature"
            )(audio)
        return RhythmResult(
            bpm=round(float(bpm), 1),
            confidence=round(float(confidence), 2),
            method="multifeature",
            candidates=rank_bpm_candidates(float(bpm), [float(e) for e in estimates]),
        )
