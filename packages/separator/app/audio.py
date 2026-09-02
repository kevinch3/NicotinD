"""Decode with ffmpeg (Opus is the library's standard codec and libsndfile
cannot read it), write the instrumental as FLAC with soundfile."""

from __future__ import annotations

import math
import subprocess
from pathlib import Path

import numpy as np

SAMPLE_RATE = 44100
FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"


def probe_duration_sec(path: str | Path) -> float | None:
    """Container duration, or None when ffprobe cannot read the file."""
    try:
        out = subprocess.run(
            [
                FFPROBE,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    try:
        sec = float(out.stdout.strip())
    except ValueError:
        return None
    return sec if math.isfinite(sec) and sec > 0 else None


def decode_stereo_f32(path: str | Path, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """`(2, n)` float32 at `sample_rate`; mono sources are upmixed by ffmpeg."""
    proc = subprocess.run(
        [
            FFMPEG,
            "-v",
            "error",
            "-i",
            str(path),
            "-vn",
            "-f",
            "f32le",
            "-ac",
            "2",
            "-ar",
            str(sample_rate),
            "-",
        ],
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0 or not proc.stdout:
        raise ValueError(
            f"ffmpeg could not decode {path}: {proc.stderr.decode(errors='replace')[:200]}"
        )
    samples = np.frombuffer(proc.stdout, dtype=np.float32)
    return np.ascontiguousarray(samples.reshape(-1, 2).T)


def write_flac(path: str | Path, audio: np.ndarray, sample_rate: int) -> None:
    """`(channels, n)` float → 16-bit FLAC, clipped (never wrapped) at full scale."""
    import soundfile as sf

    sf.write(str(path), np.clip(audio.T, -1.0, 1.0), sample_rate, format="FLAC", subtype="PCM_16")
