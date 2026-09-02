"""ffmpeg does the decoding (Opus is the library's standard codec); soundfile
writes the FLAC. Skipped where the binaries are absent."""

import shutil
import wave
from pathlib import Path

import numpy as np
import pytest

from app import audio

HAS_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def write_wav(path: Path, seconds: float = 2.0) -> np.ndarray:
    rate = 44100
    n = int(rate * seconds)
    t = np.arange(n) / rate
    left = 0.5 * np.sin(2 * np.pi * 440 * t)
    right = 0.25 * np.sin(2 * np.pi * 660 * t)
    pcm = np.stack([left, right]).T
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((pcm * 32767).astype("<i2").tobytes())
    return np.stack([left, right]).astype(np.float32)


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe not on PATH")
def test_probe_duration_reads_the_container_length(tmp_path: Path) -> None:
    write_wav(tmp_path / "in.wav", seconds=2.0)
    assert audio.probe_duration_sec(tmp_path / "in.wav") == pytest.approx(2.0, abs=0.05)


def test_probe_duration_is_none_for_garbage(tmp_path: Path) -> None:
    (tmp_path / "junk.mp3").write_bytes(b"not audio")
    assert audio.probe_duration_sec(tmp_path / "junk.mp3") is None


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe not on PATH")
def test_decode_yields_float32_stereo_at_the_model_rate(tmp_path: Path) -> None:
    expected = write_wav(tmp_path / "in.wav", seconds=1.0)
    out = audio.decode_stereo_f32(tmp_path / "in.wav")
    assert out.dtype == np.float32
    assert out.shape == (2, 44100)
    assert np.allclose(out, expected, atol=2e-4)


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe not on PATH")
def test_write_flac_round_trips_and_clips(tmp_path: Path) -> None:
    pytest.importorskip("soundfile")
    src = write_wav(tmp_path / "in.wav", seconds=0.5) * 3.0  # peaks at 1.5: must clip, not wrap
    audio.write_flac(tmp_path / "out.flac", src, 44100)
    back = audio.decode_stereo_f32(tmp_path / "out.flac")
    assert back.shape == src.shape
    assert back.max() <= 1.0 and back.min() >= -1.0
    assert np.allclose(back, np.clip(src, -1.0, 1.0), atol=2e-4)
