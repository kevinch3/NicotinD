"""Pure groove statistics over a beat grid + onset list — no Essentia needed.

The fixtures are synthetic grids with KNOWN properties (a metronome, a drifting
tempo, straight vs triplet off-beats), so every expectation here is a number
the definition must reproduce, not a value read off a real recording.
"""

import itertools

import pytest

from app.beat_stats import (
    beat_phases,
    groove_regularity,
    swing_ratio,
    syncopation,
    tempo_stability,
)


def grid(bpm: float, beats: int, start: float = 0.0) -> list[float]:
    interval = 60.0 / bpm
    return [start + i * interval for i in range(beats)]


def with_offbeats(beats: list[float], phase: float) -> list[float]:
    """Onsets on every beat plus one off-beat at `phase` (0..1) of each interval."""
    onsets: list[float] = []
    for a, b in itertools.pairwise(beats):
        onsets.append(a)
        onsets.append(a + (b - a) * phase)
    onsets.append(beats[-1])
    return onsets


# ─── beat_phases ─────────────────────────────────────────────────────────────


def test_beat_phases_places_each_onset_inside_its_beat() -> None:
    beats = grid(120, 4)  # 0.0, 0.5, 1.0, 1.5
    assert beat_phases(beats, [0.0, 0.25, 0.5, 1.375]) == pytest.approx([0.0, 0.5, 0.0, 0.75])


def test_beat_phases_drops_onsets_outside_the_grid() -> None:
    beats = grid(120, 3)  # 0.0, 0.5, 1.0
    assert beat_phases(beats, [-0.1, 0.25, 1.2]) == pytest.approx([0.5])


# ─── tempo_stability ─────────────────────────────────────────────────────────


def test_tempo_stability_is_one_for_a_metronome() -> None:
    assert tempo_stability(grid(128, 200)) == pytest.approx(1.0)


def test_tempo_stability_drops_when_the_tempo_drifts() -> None:
    # 120 → 140 bpm over the grid: a rubato-style drift, not jitter.
    beats: list[float] = [0.0]
    for i in range(199):
        bpm = 120 + 20 * (i / 198)
        beats.append(beats[-1] + 60.0 / bpm)
    drifting = tempo_stability(beats)
    assert 0.0 <= drifting < 0.9
    assert drifting < tempo_stability(grid(128, 200))


def test_tempo_stability_needs_a_usable_grid() -> None:
    assert tempo_stability([]) is None
    assert tempo_stability([0.0, 0.5]) is None


# ─── groove_regularity ───────────────────────────────────────────────────────


def test_groove_regularity_is_one_for_a_metronome() -> None:
    assert groove_regularity(grid(128, 200)) == pytest.approx(1.0)


def test_groove_regularity_penalises_beat_to_beat_jitter_not_slow_drift() -> None:
    # Same mean tempo, alternating ±30 ms around it — human "push/pull".
    jittered: list[float] = [0.0]
    for i in range(199):
        jittered.append(jittered[-1] + 0.5 + (0.03 if i % 2 else -0.03))
    drifting: list[float] = [0.0]
    for i in range(199):
        drifting.append(drifting[-1] + 60.0 / (120 + 20 * (i / 198)))
    assert groove_regularity(jittered) < groove_regularity(drifting)


# ─── swing_ratio ─────────────────────────────────────────────────────────────


def test_swing_ratio_is_half_for_straight_eighths() -> None:
    beats = grid(120, 64)
    assert swing_ratio(beats, with_offbeats(beats, 0.5)) == pytest.approx(0.5, abs=0.02)


def test_swing_ratio_is_two_thirds_for_triplet_swing() -> None:
    beats = grid(120, 64)
    assert swing_ratio(beats, with_offbeats(beats, 2 / 3)) == pytest.approx(2 / 3, abs=0.02)


def test_swing_ratio_is_none_without_offbeat_onsets() -> None:
    beats = grid(120, 64)
    assert swing_ratio(beats, list(beats)) is None


# ─── syncopation ─────────────────────────────────────────────────────────────


def test_syncopation_is_near_zero_for_on_grid_onsets() -> None:
    beats = grid(120, 64)
    assert syncopation(beats, with_offbeats(beats, 0.5)) == pytest.approx(0.0, abs=0.02)


def test_syncopation_is_high_for_sixteenth_offsets() -> None:
    # Every onset lands a sixteenth away from both the beat and the off-beat.
    beats = grid(120, 64)
    onsets = [a + (b - a) * 0.25 for a, b in itertools.pairwise(beats)]
    onsets += [a + (b - a) * 0.75 for a, b in itertools.pairwise(beats)]
    assert syncopation(beats, sorted(onsets)) == pytest.approx(1.0, abs=0.02)


def test_syncopation_is_none_without_onsets() -> None:
    assert syncopation(grid(120, 8), []) is None
