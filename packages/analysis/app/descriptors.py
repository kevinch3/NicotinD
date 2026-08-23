"""Per-track audio descriptors (timbre / groove / spectral balance): the
injectable boundary between the HTTP app and Essentia's MusicExtractor.

Why a separate endpoint from /analyze: the ML models decode at 16 kHz
(Nyquist 8 kHz), so the 6–16 kHz band cannot exist on that path, and
Essentia's OnsetRate throws on anything but 44.1 kHz. This pass decodes its
own 44.1 kHz window.

Why a temp WAV: MusicExtractor only takes a *filename* and loads it through
Essentia's AudioLoader, which has no Opus support (the library's standard
codec — see rhythm.py). ffmpeg decodes the window to a 16-bit WAV, the
extractor reads that path, and the same file is re-read for the onset and
band passes — one decode per track. Measured on the published image:
~5 s/track for a 180 s window on a real Opus/MP3 (docs/audio-descriptors.md).

`derive_descriptors` is pure (a dict stands in for the Pool in tests);
`EssentiaDescriptorAnalyzer` is the real implementation, importing essentia
and numpy lazily like models.py. Independent of the TF registry: no model
files are needed, so /descriptors keeps working on a models-less build.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import threading
import wave
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol

from .bands import BAND_EDGES_HZ, BAND_NAMES, band_shares
from .beat_stats import groove_regularity, swing_ratio, syncopation, tempo_stability

# Bump when a descriptor's definition changes — the API re-analyzes rows
# stored under an older version rather than mixing definitions in one axis.
DESCRIPTOR_VERSION = 1

SAMPLE_RATE = 44100
WINDOW_SECONDS_DEFAULT = 180.0
# Below this there is no tempo to lock and no spectrum worth averaging.
MIN_AUDIO_SECONDS = 5.0
# MusicExtractor's own low-level frame/hop, reused for the band pass so the
# two read the same spectral frames.
FRAME_SIZE = 2048
HOP_SIZE = 1024

# The only keys copied out of the Essentia Pool (583 descriptors on the
# published image). Measured names — there is no `spectral_flatness_db` in
# MusicExtractor's output; bark-band flatness is what it emits.
POOL_KEYS: list[str] = [
    "lowlevel.mfcc.mean",
    "lowlevel.spectral_centroid.mean",
    "lowlevel.spectral_spread.mean",
    "lowlevel.spectral_rolloff.mean",
    "lowlevel.spectral_flux.mean",
    "lowlevel.barkbands_flatness_db.mean",
    "lowlevel.spectral_complexity.mean",
    "lowlevel.zerocrossingrate.mean",
    "lowlevel.pitch_salience.mean",
    "lowlevel.dynamic_complexity",
    "lowlevel.loudness_ebu128.loudness_range",
    "rhythm.onset_rate",
    "rhythm.beats_loudness.mean",
    "rhythm.beats_loudness_band_ratio.mean",
    "rhythm.danceability",
    "rhythm.bpm",
    "tonal.chords_changes_rate",
    "tonal.key_edma.strength",
]

MFCC_COUNT = 13

# The flat contract, in output order. The API's descriptor store groups these
# into its timbre / groove / bands blocks by name; a rename here is a contract
# change and needs DESCRIPTOR_VERSION bumped.
DESCRIPTOR_NAMES: list[str] = [
    *[f"mfcc_{i}" for i in range(MFCC_COUNT)],
    "spectral_centroid",
    "spectral_bandwidth",
    "spectral_rolloff",
    "spectral_flux",
    "spectral_flatness",
    "spectral_complexity",
    "zero_crossing_rate",
    "pitch_salience",
    "onset_rate",
    "beat_strength",
    "tempo_stability",
    "swing_ratio",
    "groove_regularity",
    "syncopation",
    "danceability_dsp",
    "kick_weight",
    *[f"band_{name}" for name in BAND_NAMES],
    "chords_changes_rate",
    "key_strength",
    "dynamic_complexity",
    "loudness_range",
    "bpm",
]


def descriptor_window_seconds(env: Mapping[str, str] | None = None) -> float:
    """Length of the analysed head of each track (`ANALYSIS_DESCRIPTOR_SECONDS`).

    Non-numeric or non-positive values fall back to the default rather than
    disabling the window — a zero-length decode would 422 every file.
    """
    raw = (os.environ if env is None else env).get("ANALYSIS_DESCRIPTOR_SECONDS")
    if raw is None:
        return WINDOW_SECONDS_DEFAULT
    try:
        value = float(raw)
    except ValueError:
        return WINDOW_SECONDS_DEFAULT
    return value if value > 0 else WINDOW_SECONDS_DEFAULT


@dataclass
class DescriptorResult:
    version: int
    features: dict[str, float | None]


class DescriptorAnalyzer(Protocol):
    def analyze(self, path: str) -> DescriptorResult: ...


def _scalar(pool: Mapping[str, object], key: str) -> float | None:
    value = pool.get(key)
    if value is None or isinstance(value, (list, tuple)):
        return None
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _component(pool: Mapping[str, object], key: str, index: int) -> float | None:
    value = pool.get(key)
    if not isinstance(value, (list, tuple)) or index >= len(value):
        return None
    try:
        return float(value[index])
    except (TypeError, ValueError):
        return None


def derive_descriptors(
    pool: Mapping[str, object],
    beats: Sequence[float],
    onsets: Sequence[float],
    band_energies: Sequence[float],
) -> dict[str, float | None]:
    """Map Essentia's pool keys + the beat grid + onsets + band energies onto
    the flat named contract. A missing key or an undefined statistic (no
    off-beat onsets → no swing) is None, never an error: the file is fine,
    the value just isn't there."""
    shares = band_shares(band_energies)
    out: dict[str, float | None] = {}
    for i in range(MFCC_COUNT):
        out[f"mfcc_{i}"] = _component(pool, "lowlevel.mfcc.mean", i)
    out["spectral_centroid"] = _scalar(pool, "lowlevel.spectral_centroid.mean")
    out["spectral_bandwidth"] = _scalar(pool, "lowlevel.spectral_spread.mean")
    out["spectral_rolloff"] = _scalar(pool, "lowlevel.spectral_rolloff.mean")
    out["spectral_flux"] = _scalar(pool, "lowlevel.spectral_flux.mean")
    out["spectral_flatness"] = _scalar(pool, "lowlevel.barkbands_flatness_db.mean")
    out["spectral_complexity"] = _scalar(pool, "lowlevel.spectral_complexity.mean")
    out["zero_crossing_rate"] = _scalar(pool, "lowlevel.zerocrossingrate.mean")
    out["pitch_salience"] = _scalar(pool, "lowlevel.pitch_salience.mean")
    out["onset_rate"] = _scalar(pool, "rhythm.onset_rate")
    out["beat_strength"] = _scalar(pool, "rhythm.beats_loudness.mean")
    out["tempo_stability"] = tempo_stability(beats)
    out["swing_ratio"] = swing_ratio(beats, onsets)
    out["groove_regularity"] = groove_regularity(beats)
    out["syncopation"] = syncopation(beats, onsets)
    out["danceability_dsp"] = _scalar(pool, "rhythm.danceability")
    out["kick_weight"] = _component(pool, "rhythm.beats_loudness_band_ratio.mean", 0)
    for i, name in enumerate(BAND_NAMES):
        out[f"band_{name}"] = None if shares is None else shares[i]
    out["chords_changes_rate"] = _scalar(pool, "tonal.chords_changes_rate")
    out["key_strength"] = _scalar(pool, "tonal.key_edma.strength")
    out["dynamic_complexity"] = _scalar(pool, "lowlevel.dynamic_complexity")
    out["loudness_range"] = _scalar(pool, "lowlevel.loudness_ebu128.loudness_range")
    out["bpm"] = _scalar(pool, "rhythm.bpm")
    return out


def decode_window_to_wav(path: str, wav_path: str, seconds: float) -> None:
    """Decode the head of any codec to a 44.1 kHz mono 16-bit WAV via ffmpeg."""
    proc = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-t",
            str(seconds),
            "-i",
            path,
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(SAMPLE_RATE),
            "-sample_fmt",
            "s16",
            "-f",
            "wav",
            wav_path,
        ],
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg decode failed: {proc.stderr.decode(errors='replace')[:300]}")


def _to_python(value: object) -> object:
    """numpy scalars/arrays → plain floats/lists so the mapping stays pure."""
    tolist = getattr(value, "tolist", None)
    return tolist() if callable(tolist) else value


class EssentiaDescriptorAnalyzer:
    """MusicExtractor + OnsetRate + FrequencyBands over one decoded window.

    Calls are serialized with a lock — Essentia standard-mode algorithms are
    not thread-safe and FastAPI runs sync endpoints in a threadpool.
    """

    def __init__(self, window_seconds: float | None = None) -> None:
        # Fail fast at construction when essentia is missing so the app wires
        # a None analyzer and /descriptors 503s instead of 500ing per request.
        import essentia.standard  # type: ignore[import-not-found]  # noqa: F401

        self._lock = threading.Lock()
        self._window = window_seconds if window_seconds is not None else descriptor_window_seconds()

    def analyze(self, path: str) -> DescriptorResult:
        import essentia.standard as es  # type: ignore[import-not-found]
        import numpy as np  # type: ignore[import-not-found]

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            wav_path = tmp.name
        try:
            decode_window_to_wav(path, wav_path, self._window)
            with wave.open(wav_path) as w:
                frames = w.readframes(w.getnframes())
            audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
            if audio.size < SAMPLE_RATE * MIN_AUDIO_SECONDS:
                raise RuntimeError("decoded audio too short")

            with self._lock:
                pool, _frames = es.MusicExtractor(rhythmMethod="multifeature")(wav_path)
                names = set(pool.descriptorNames())
                values = {k: _to_python(pool[k]) for k in POOL_KEYS if k in names}
                beats = (
                    [float(b) for b in pool["rhythm.beats_position"]]
                    if "rhythm.beats_position" in names
                    else []
                )
                onsets_arr, _rate = es.OnsetRate()(audio)
                onsets = [float(t) for t in onsets_arr]
                energies = _band_energies(es, audio)
        finally:
            try:
                os.unlink(wav_path)
            except OSError:
                pass

        return DescriptorResult(
            version=DESCRIPTOR_VERSION,
            features=derive_descriptors(values, beats, onsets, energies),
        )


def _band_energies(es: object, audio: object) -> list[float]:
    """Sum per-frame energy in each of the six bands over the whole window."""
    bands = es.FrequencyBands(frequencyBands=BAND_EDGES_HZ, sampleRate=SAMPLE_RATE)  # type: ignore[attr-defined]
    spectrum = es.Spectrum()  # type: ignore[attr-defined]
    window = es.Windowing(type="hann")  # type: ignore[attr-defined]
    acc = [0.0] * len(BAND_NAMES)
    for frame in es.FrameGenerator(  # type: ignore[attr-defined]
        audio, frameSize=FRAME_SIZE, hopSize=HOP_SIZE, startFromZero=True
    ):
        for i, e in enumerate(bands(spectrum(window(frame)))):
            acc[i] += float(e)
    return acc
