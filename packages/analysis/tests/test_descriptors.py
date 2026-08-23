"""Pure pool → named-descriptor mapping and env parsing — no Essentia needed.

`derive_descriptors` is the seam between Essentia's Pool (583 keys, arrays,
its own naming) and the flat named contract the API stores. A dict stands in
for the Pool here; the real analyzer copies only the keys it needs into one.
"""

import itertools

import pytest

from app.bands import BAND_NAMES
from app.descriptors import (
    DESCRIPTOR_NAMES,
    DESCRIPTOR_VERSION,
    POOL_KEYS,
    derive_descriptors,
    descriptor_window_seconds,
)


def fake_pool(**overrides: object) -> dict[str, object]:
    pool: dict[str, object] = {
        "lowlevel.mfcc.mean": [float(i) for i in range(13)],
        "lowlevel.spectral_centroid.mean": 1138.3,
        "lowlevel.spectral_spread.mean": 4770314.0,
        "lowlevel.spectral_rolloff.mean": 1306.8,
        "lowlevel.spectral_flux.mean": 0.0975,
        "lowlevel.barkbands_flatness_db.mean": 0.21,
        "lowlevel.spectral_complexity.mean": 15.36,
        "lowlevel.zerocrossingrate.mean": 0.0539,
        "lowlevel.pitch_salience.mean": 0.519,
        "lowlevel.dynamic_complexity": 2.71,
        "lowlevel.loudness_ebu128.loudness_range": 3.16,
        "rhythm.onset_rate": 5.25,
        "rhythm.beats_loudness.mean": 0.0839,
        "rhythm.beats_loudness_band_ratio.mean": [0.62, 0.2, 0.1, 0.05, 0.02, 0.01],
        "rhythm.danceability": 1.6,
        "rhythm.bpm": 150.0,
        "tonal.chords_changes_rate": 0.04,
        "tonal.key_edma.strength": 0.66,
    }
    pool.update(overrides)
    return pool


def grid(bpm: float, beats: int) -> list[float]:
    return [i * 60.0 / bpm for i in range(beats)]


def test_derive_descriptors_is_exactly_the_declared_contract() -> None:
    beats = grid(150, 64)
    out = derive_descriptors(fake_pool(), beats, beats, [1.0, 2.0, 1.0, 1.0, 0.5, 0.5])
    assert list(out.keys()) == DESCRIPTOR_NAMES
    assert DESCRIPTOR_VERSION == 1


def test_derive_descriptors_flattens_mfcc_and_maps_pool_keys() -> None:
    beats = grid(150, 64)
    out = derive_descriptors(fake_pool(), beats, beats, [1.0, 2.0, 1.0, 1.0, 0.5, 0.5])
    assert [out[f"mfcc_{i}"] for i in range(13)] == [float(i) for i in range(13)]
    # Essentia has no `spectral_flatness_db`; the bark-band flatness is the one
    # MusicExtractor actually emits (measured on the published image).
    assert out["spectral_flatness"] == pytest.approx(0.21)
    assert out["spectral_bandwidth"] == pytest.approx(4770314.0)
    assert out["zero_crossing_rate"] == pytest.approx(0.0539)
    assert out["beat_strength"] == pytest.approx(0.0839)
    assert out["kick_weight"] == pytest.approx(0.62)
    assert out["danceability_dsp"] == pytest.approx(1.6)
    assert out["key_strength"] == pytest.approx(0.66)
    assert out["loudness_range"] == pytest.approx(3.16)
    assert out["bpm"] == pytest.approx(150.0)


def test_derive_descriptors_computes_groove_stats_from_the_grid() -> None:
    beats = grid(150, 64)
    onsets = []
    for a, b in itertools.pairwise(beats):
        onsets += [a, a + (b - a) * 0.5]
    out = derive_descriptors(fake_pool(), beats, onsets, [1.0] * 6)
    assert out["tempo_stability"] == pytest.approx(1.0)
    assert out["groove_regularity"] == pytest.approx(1.0)
    assert out["swing_ratio"] == pytest.approx(0.5, abs=0.02)
    assert out["syncopation"] == pytest.approx(0.0, abs=0.02)


def test_derive_descriptors_band_shares_are_named_and_sum_to_one() -> None:
    beats = grid(150, 64)
    out = derive_descriptors(fake_pool(), beats, beats, [1.0, 3.0, 2.0, 2.0, 1.0, 1.0])
    shares = [out[f"band_{name}"] for name in BAND_NAMES]
    assert sum(shares) == pytest.approx(1.0)
    assert out["band_bass"] == pytest.approx(0.3)


def test_derive_descriptors_missing_values_are_none_not_errors() -> None:
    # A missing pool key (older extractor build) or an undefined stat (no
    # off-beat onsets → no swing) must land as None so the API can decide,
    # rather than a 422 that ledgers a perfectly good file.
    pool = fake_pool()
    del pool["lowlevel.pitch_salience.mean"]
    beats = grid(150, 64)
    out = derive_descriptors(pool, beats, [], [0.0] * 6)
    assert out["pitch_salience"] is None
    assert out["swing_ratio"] is None
    assert out["syncopation"] is None
    assert out["band_bass"] is None


def test_pool_keys_lists_everything_the_mapping_reads() -> None:
    # The real analyzer copies only POOL_KEYS out of the Essentia Pool; a key
    # the mapping reads but the list forgets would be None on every track.
    assert set(POOL_KEYS) == set(fake_pool().keys())


def test_descriptor_window_seconds_defaults_and_parses_env() -> None:
    assert descriptor_window_seconds({}) == 180.0
    assert descriptor_window_seconds({"ANALYSIS_DESCRIPTOR_SECONDS": "90"}) == 90.0
    assert descriptor_window_seconds({"ANALYSIS_DESCRIPTOR_SECONDS": "0"}) == 180.0
    assert descriptor_window_seconds({"ANALYSIS_DESCRIPTOR_SECONDS": "-5"}) == 180.0
    assert descriptor_window_seconds({"ANALYSIS_DESCRIPTOR_SECONDS": "lots"}) == 180.0
