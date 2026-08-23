"""Band-energy → share normalisation — pure, no Essentia needed."""

import pytest

from app.bands import BAND_EDGES_HZ, BAND_NAMES, band_shares


def test_six_named_bands_over_seven_edges() -> None:
    assert BAND_EDGES_HZ == [20, 60, 250, 500, 2000, 6000, 16000]
    assert BAND_NAMES == ["sub_bass", "bass", "low_mid", "mid", "high_mid", "high"]


def test_band_shares_sum_to_one() -> None:
    shares = band_shares([1.0, 3.0, 2.0, 2.0, 1.0, 1.0])
    assert sum(shares) == pytest.approx(1.0)
    assert shares[1] == pytest.approx(0.3)


def test_band_shares_rejects_silence() -> None:
    # All-zero energy has no distribution to describe; callers treat None as
    # "no usable descriptor", never as a flat spectrum.
    assert band_shares([0.0] * 6) is None


def test_band_shares_rejects_wrong_arity() -> None:
    with pytest.raises(ValueError):
        band_shares([1.0, 2.0])
