"""Real-model test: only runs where the checkpoint AND torch are present
(`SEPARATOR_MODELS_DIR`, e.g. inside the published image or on the GPU host).
Prints the measured real-time factor so the API's SEPARATION_RTF constant can
be re-checked against this exact windowing."""

import importlib.util
import os
import time
from pathlib import Path

import numpy as np
import pytest

MODELS_DIR = os.environ.get("SEPARATOR_MODELS_DIR")
HAS_TORCH = importlib.util.find_spec("torch") is not None
pytestmark = pytest.mark.skipif(
    not MODELS_DIR or not Path(MODELS_DIR).is_dir() or not HAS_TORCH,
    reason="real checkpoint + torch required",
)


def test_synthetic_mix_separates_to_a_finite_quieter_instrumental(tmp_path: Path) -> None:
    from app import audio
    from app.model import separate_file

    rate = 44100
    t = np.arange(rate * 6) / rate
    mix = np.stack(
        [0.3 * np.sin(2 * np.pi * 220 * t) + 0.2 * np.sin(2 * np.pi * 3000 * t)] * 2
    ).astype(np.float32)
    src = tmp_path / "mix.flac"
    audio.write_flac(src, mix, rate)
    out = tmp_path / "inst.flac"

    started = time.monotonic()
    info = separate_file(
        str(src),
        str(out),
        models_dir=MODELS_DIR,
        device=os.environ.get("SEPARATOR_DEVICE", "cuda"),
        max_sec=900,
    )
    elapsed = time.monotonic() - started

    inst = audio.decode_stereo_f32(out)
    assert np.isfinite(inst).all()
    assert inst.shape == mix.shape
    assert float(np.mean(inst**2)) <= float(np.mean(mix**2)) * 1.05
    rtf = elapsed / info["duration_sec"]
    print(f"RTF {rtf:.3f} ({elapsed:.1f}s for {info['duration_sec']:.1f}s)")
