"""Model-present golden tests — skipped unless the real models are available.

Run on the host (not CI) with:

    ANALYSIS_MODELS_DIR=/path/to/models pytest packages/analysis/tests/test_golden.py -v

Generates tiny synthetic fixtures with ffmpeg and asserts deterministic,
directionally-sane model behaviour (not exact scores):
  - identical input -> identical output (drift anchor via modelVersions)
  - every score in [0, 1], mood in the vocabulary
  - a 4-on-the-floor synthetic beat scores more danceable than a pure sine
"""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

MODELS_DIR = os.environ.get("ANALYSIS_MODELS_DIR")
HAVE_ESSENTIA = True
try:  # pragma: no cover - environment probe
    import essentia  # type: ignore[import-not-found]  # noqa: F401
except Exception:  # pragma: no cover
    HAVE_ESSENTIA = False

pytestmark = pytest.mark.skipif(
    not MODELS_DIR or not HAVE_ESSENTIA or shutil.which("ffmpeg") is None,
    reason="requires ANALYSIS_MODELS_DIR, essentia-tensorflow and ffmpeg",
)


def synth(path: Path, filt: str, seconds: int = 12) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            filt,
            "-t",
            str(seconds),
            "-ar",
            "44100",
            str(path),
        ],
        check=True,
    )


@pytest.fixture(scope="module")
def registry():
    from app.models import EssentiaRegistry

    return EssentiaRegistry(MODELS_DIR)  # type: ignore[arg-type]


@pytest.fixture(scope="module")
def fixtures(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    base = tmp_path_factory.mktemp("golden")
    sine = base / "sine.wav"
    beat = base / "beat.wav"
    synth(sine, "sine=frequency=440:sample_rate=44100")
    # A crude 4-on-the-floor: low sine gated at 2 Hz (120 BPM pulse).
    synth(beat, "sine=frequency=80:sample_rate=44100,apulsator=hz=2:mode=square:amount=1")
    return {"sine": sine, "beat": beat}


def test_scores_in_range_and_versions_present(registry, fixtures) -> None:
    result = registry.analyze(str(fixtures["sine"]))
    for key in ("danceability", "valence", "acousticness", "instrumental"):
        assert 0.0 <= float(result.features[key]) <= 1.0, key
    assert result.features["mood"] in ("happy", "sad", "aggressive", "relaxed", "party")
    assert result.embedding_dim == 1280
    assert len(result.embedding) == 1280
    assert result.model_versions["embedding"] == "discogs-effnet-bs64-1"


def test_identical_input_identical_output(registry, fixtures) -> None:
    a = registry.analyze(str(fixtures["sine"]))
    b = registry.analyze(str(fixtures["sine"]))
    assert a.features == b.features
    assert a.embedding == b.embedding


def test_pulsed_beat_more_danceable_than_pure_tone(registry, fixtures) -> None:
    tone = registry.analyze(str(fixtures["sine"]))
    beat = registry.analyze(str(fixtures["beat"]))
    assert float(beat.features["danceability"]) > float(tone.features["danceability"])
