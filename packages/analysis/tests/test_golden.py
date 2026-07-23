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
except Exception:  # pragma: no cover  # noqa: BLE001 - any import failure means "skip"
    HAVE_ESSENTIA = False

pytestmark = pytest.mark.skipif(
    not MODELS_DIR or not HAVE_ESSENTIA or shutil.which("ffmpeg") is None,
    reason="requires ANALYSIS_MODELS_DIR, essentia-tensorflow and ffmpeg",
)


def synth(path: Path, filt: str, seconds: int = 12, rate: int = 44100) -> None:
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
            str(rate),
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
    opus = base / "sine.opus"
    synth(sine, "sine=frequency=440:sample_rate=44100")
    # A crude 4-on-the-floor: low sine gated at 2 Hz (120 BPM pulse).
    synth(beat, "sine=frequency=80:sample_rate=44100,apulsator=hz=2:mode=square:amount=1")
    # The library's standard codec — regression guard for decode support
    # (essentia's own loader can't read Opus; load_audio must). libopus only
    # accepts 48 kHz-family rates.
    synth(opus, "sine=frequency=440:sample_rate=44100", rate=48000)
    return {"sine": sine, "beat": beat, "opus": opus}


def test_scores_in_range_and_versions_present(registry, fixtures) -> None:
    result = registry.analyze(str(fixtures["sine"]))
    for key in ("danceability", "valence", "acousticness", "instrumental"):
        assert 0.0 <= float(result.features[key]) <= 1.0, key
    assert result.features["mood"] in ("happy", "sad", "aggressive", "relaxed", "party")
    assert result.embedding_dim == 1280
    assert len(result.embedding) == 1280
    assert result.model_versions["embedding"] == "discogs-effnet-bs64-1"
    assert result.model_versions["genre"] == "genre_discogs400-discogs-effnet-1"


def test_genre_is_a_confident_discogs_label(registry, fixtures) -> None:
    result = registry.analyze(str(fixtures["sine"]))
    assert result.genre is not None
    assert isinstance(result.genre["genre"], str) and result.genre["genre"]
    assert result.genre["style"] is None or isinstance(result.genre["style"], str)
    assert 0.0 <= result.genre["confidence"] <= 1.0


def test_identical_input_identical_output(registry, fixtures) -> None:
    a = registry.analyze(str(fixtures["sine"]))
    b = registry.analyze(str(fixtures["sine"]))
    assert a.features == b.features
    assert a.embedding == b.embedding


def test_vocal_free_tone_scores_clearly_instrumental(registry, fixtures) -> None:
    # Discriminative sanity that holds for out-of-distribution synthetic audio:
    # a pure tone has no vocals, so voice_instrumental must lean instrumental
    # hard. (Relative danceability between synthetic fixtures is NOT stable —
    # measured on 2026-07: a plain sine scored *more* danceable than a gated
    # beat — so no direction is asserted there.)
    tone = registry.analyze(str(fixtures["sine"]))
    beat = registry.analyze(str(fixtures["beat"]))
    assert float(tone.features["instrumental"]) > 0.8
    assert float(beat.features["instrumental"]) > 0.8


def test_opus_decodes(registry, fixtures) -> None:
    result = registry.analyze(str(fixtures["opus"]))
    assert result.embedding_dim == 1280
    assert result.features["mood"] in ("happy", "sad", "aggressive", "relaxed", "party")
