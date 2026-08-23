"""Frequency-band energy → shares. Pure Python so it imports in the dev/CI
install, which has no numpy (that lives behind the `models` extra)."""

from __future__ import annotations

from collections.abc import Sequence

# Six perceptual bands over seven edges. Essentia's MusicExtractor ships its
# own four-band split (20/150/800/4k/20k); these are the edges the radio and
# the waveform VFX were designed around, so the sidecar computes them
# explicitly with FrequencyBands over the 44.1 kHz decode (the top band needs
# a Nyquist above 16 kHz — unreachable on /analyze's 16 kHz path).
BAND_EDGES_HZ: list[int] = [20, 60, 250, 500, 2000, 6000, 16000]
BAND_NAMES: list[str] = ["sub_bass", "bass", "low_mid", "mid", "high_mid", "high"]


def band_shares(energies: Sequence[float]) -> list[float] | None:
    """Normalise six band energies into shares summing to 1.

    Returns None for silence (all-zero energy): there is no distribution to
    describe, and a uniform fallback would read as a flat spectrum — a real,
    and wrong, spectral-balance signal.
    """
    if len(energies) != len(BAND_NAMES):
        raise ValueError(f"expected {len(BAND_NAMES)} band energies, got {len(energies)}")
    total = float(sum(max(0.0, float(e)) for e in energies))
    if total <= 0.0:
        return None
    return [max(0.0, float(e)) / total for e in energies]
