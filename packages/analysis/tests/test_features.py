"""Pure-function invariants — no Essentia/TensorFlow needed."""

import pytest

from app.features import (
    MOOD_HEADS,
    MOOD_VOCAB,
    derive_features,
    head_probability,
    normalize_valence,
)


def flat_heads(**overrides: list[float]) -> dict[str, list[float]]:
    """All heads at 50/50, individually overridable."""
    heads = {head: [0.5, 0.5] for head in ["danceability", "mood_acoustic", "voice_instrumental"]}
    heads.update({head: [0.5, 0.5] for head in MOOD_HEADS.values()})
    heads.update(overrides)
    return heads


def test_head_probability_respects_per_head_class_order() -> None:
    # danceability is positive-first; mood_sad is positive-second.
    assert head_probability("danceability", [0.9, 0.1]) == 0.9
    assert head_probability("mood_sad", [0.9, 0.1]) == 0.1


def test_head_probability_clamps_into_unit_range() -> None:
    assert head_probability("danceability", [1.7, 0.0]) == 1.0
    assert head_probability("danceability", [-0.2, 0.0]) == 0.0


def test_head_probability_rejects_short_output() -> None:
    with pytest.raises(ValueError):
        head_probability("mood_sad", [0.4])


def test_normalize_valence_maps_1_to_9_scale() -> None:
    assert normalize_valence(1.0) == 0.0
    assert normalize_valence(9.0) == 1.0
    assert normalize_valence(5.0) == 0.5
    # Out-of-range regression outputs clamp instead of leaking.
    assert normalize_valence(0.0) == 0.0
    assert normalize_valence(12.0) == 1.0


def test_derive_features_scores_are_unit_range_and_mood_in_vocab() -> None:
    features = derive_features(flat_heads(), valence_raw=5.0)
    for key in ("danceability", "valence", "acousticness", "instrumental"):
        value = features[key]
        assert isinstance(value, float)
        assert 0.0 <= value <= 1.0
    assert features["mood"] in MOOD_VOCAB


def test_derive_features_mood_is_argmax_over_mood_heads() -> None:
    features = derive_features(flat_heads(mood_party=[0.05, 0.95]), valence_raw=5.0)
    assert features["mood"] == "party"

    # mood_sad is positive-second: a [0.02, 0.98] output means very sad.
    features = derive_features(flat_heads(mood_sad=[0.02, 0.98]), valence_raw=2.0)
    assert features["mood"] == "sad"


def test_derive_features_is_deterministic() -> None:
    heads = flat_heads(danceability=[0.8, 0.2])
    assert derive_features(heads, 6.3) == derive_features(heads, 6.3)
