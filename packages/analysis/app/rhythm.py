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

import subprocess
import threading
from dataclasses import dataclass
from typing import Protocol

# RhythmExtractor2013 is designed for 44.1 kHz input. A 90 s slice is plenty
# to lock a stable tempo (matches the bun-side analyzer's window) and keeps
# the multifeature method fast (~1.3 s/track).
SAMPLE_RATE = 44100
ANALYZE_SECONDS = 90


@dataclass
class RhythmResult:
    bpm: float
    confidence: float
    method: str


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
            bpm, _beats, confidence, _estimates, _intervals = es.RhythmExtractor2013(
                method="multifeature"
            )(audio)
        return RhythmResult(
            bpm=round(float(bpm), 1),
            confidence=round(float(confidence), 2),
            method="multifeature",
        )
