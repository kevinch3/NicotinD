"""Groove statistics over a beat grid + onset list (the "groove" descriptor
block). Pure Python — no numpy, so it imports in the dev/CI install.

Inputs come from MusicExtractor's `rhythm.beats_position` (the beat grid) and
`OnsetRate`'s onset times, both in seconds. Everything here is a statistic
over those two lists; nothing touches audio.

Two of these split what a single "timing deviation" number would blur:
`tempo_stability` measures SLOW drift (rubato, a live band speeding up) and
`groove_regularity` measures FAST beat-to-beat jitter (human push/pull). A
metronome scores 1.0 on both; a drifting-but-steady grid scores low on the
first and ~1.0 on the second; a jittered grid the reverse.
"""

from __future__ import annotations

import itertools
from bisect import bisect_right
from collections.abc import Sequence
from statistics import median, pstdev

# Number of inter-beat intervals per window when measuring drift. Two bars of
# 4/4 — long enough that jitter averages out, short enough that a gradual
# tempo change shows up as window-to-window movement.
DRIFT_WINDOW_BEATS = 8

# Drift at which tempo_stability reaches 0: a window-mean spread (coefficient
# of variation) of 10% ≈ 120 → 132 bpm across the song.
DRIFT_CV_AT_ZERO = 0.10

# Jitter at which groove_regularity reaches 0: a mean successive-interval
# change of 20% of the beat. A ±30 ms alternation at 120 bpm is 12% → 0.4.
JITTER_AT_ZERO = 0.20

# Off-beat onset phases considered for swing. Straight eighths sit at 0.5,
# triplet swing at 0.667; the window excludes on-beat onsets (≈0 / ≈1) and the
# sixteenth just after the beat.
SWING_PHASE_MIN = 0.30
SWING_PHASE_MAX = 0.85

# Grid distance (in beat phase) below which an onset counts as ON the grid
# for syncopation: ~30 ms at 120 bpm, the order of OnsetRate's resolution and
# of a tight human player's spread. Without it, detector jitter alone puts a
# quantized track at ≈0.09.
SYNCOPATION_DEAD_ZONE = 0.06


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def _intervals(beats: Sequence[float]) -> list[float]:
    return [b - a for a, b in itertools.pairwise(beats)]


def beat_phases(beats: Sequence[float], onsets: Sequence[float]) -> list[float]:
    """Position of each onset inside its beat, 0 (on the beat) ..< 1.

    Onsets before the first beat or at/after the last one have no enclosing
    interval and are dropped rather than guessed.
    """
    if len(beats) < 2:
        return []
    phases: list[float] = []
    for t in onsets:
        i = bisect_right(beats, t) - 1
        if i < 0 or i >= len(beats) - 1:
            continue
        span = beats[i + 1] - beats[i]
        if span <= 0:
            continue
        phases.append((t - beats[i]) / span)
    return phases


def tempo_stability(beats: Sequence[float]) -> float | None:
    """1.0 for a constant tempo, falling toward 0 as the tempo drifts.

    Spread of per-window mean intervals (not per-beat), so jitter cancels and
    only a sustained change registers. None below two intervals.
    """
    iv = _intervals(beats)
    if len(iv) < 2:
        return None
    windows = [
        sum(iv[i : i + DRIFT_WINDOW_BEATS]) / len(iv[i : i + DRIFT_WINDOW_BEATS])
        for i in range(0, len(iv), DRIFT_WINDOW_BEATS)
    ]
    mean = sum(iv) / len(iv)
    if mean <= 0:
        return None
    cv = pstdev(windows) / mean if len(windows) > 1 else 0.0
    return _clamp01(1.0 - cv / DRIFT_CV_AT_ZERO)


def groove_regularity(beats: Sequence[float]) -> float | None:
    """1.0 for a metronome, falling toward 0 with beat-to-beat jitter.

    Mean absolute change between successive intervals, relative to the mean
    interval — a slow drift changes each interval by almost nothing, so it
    scores ≈1.0 here. None below two intervals.
    """
    iv = _intervals(beats)
    if len(iv) < 2:
        return None
    mean = sum(iv) / len(iv)
    if mean <= 0:
        return None
    jitter = sum(abs(b - a) for a, b in itertools.pairwise(iv)) / (len(iv) - 1) / mean
    return _clamp01(1.0 - jitter / JITTER_AT_ZERO)


def swing_ratio(beats: Sequence[float], onsets: Sequence[float]) -> float | None:
    """Where the off-beat lands inside the beat: 0.5 straight, ≈0.67 swung.

    The median phase of onsets in the off-beat window — median, not mean, so a
    few stray onsets can't drag a straight groove toward "slightly swung".
    None when no onset falls in the window (a track with nothing between the
    beats has no swing to speak of).
    """
    offbeats = [p for p in beat_phases(beats, onsets) if SWING_PHASE_MIN <= p <= SWING_PHASE_MAX]
    if not offbeats:
        return None
    return median(offbeats)


def syncopation(beats: Sequence[float], onsets: Sequence[float]) -> float | None:
    """Share of rhythmic activity that lands OFF the eighth-note grid, 0..1.

    Contract (see tests/test_beat_stats.py):
      - onsets exactly on beats and on straight off-beats (phase 0 / 0.5) → ≈0
      - onsets exactly on sixteenth offsets (phase 0.25 / 0.75)           → ≈1
      - no onsets inside the grid                                         → None

    Per onset: distance to the nearest eighth-note grid point (phase 0, 0.5 or
    1), graded linearly from a dead zone up to a full sixteenth (0.25, the
    farthest an onset can sit from the grid). Graded rather than thresholded
    because this feeds a cosine similarity axis, where a step function makes
    two tracks a millisecond apart look maximally different; the dead zone is
    what keeps "graded" from rewarding looseness — OnsetRate resolves to
    ~12 ms (phase 0.023 at 120 bpm), and a human drummer's tightness is of the
    same order, so distances under `SYNCOPATION_DEAD_ZONE` are noise, not
    placement. The straight off-beat (0.5) scores 0 by construction —
    `swing_ratio` owns where the off-beat lands.
    """
    phases = beat_phases(beats, onsets)
    if not phases:
        return None
    span = 0.25 - SYNCOPATION_DEAD_ZONE
    scores = []
    for p in phases:
        dist = min(p, abs(p - 0.5), 1.0 - p)
        scores.append(_clamp01((dist - SYNCOPATION_DEAD_ZONE) / span))
    return sum(scores) / len(scores)
