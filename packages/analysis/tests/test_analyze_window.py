"""analyze_window_seconds(): the bound that keeps one long track off the box.

`/analyze` was the only endpoint that decoded a whole file. `load_audio` buffers
the entire PCM stream via `subprocess.run(capture_output=True)`, so peak RSS was
a function of track length rather than a constant: one 8 h 35 m live set
(30,915 s) needed ~1.98 GB of float32 PCM before a single inference ran. With no
memory limit on the container at the time, that repeatedly OOM-killed the
sidecar, and because the failure was never ledgered the same file was retried
forever (#1048). `rhythm.py` and `descriptors.py` already windowed their decode;
this path did not.

A non-positive window must never reach ffmpeg: `-t 0` decodes nothing, which
would 422 every file in the library.
"""

import app.models as models
from app.models import (
    ANALYZE_WINDOW_SECONDS_DEFAULT,
    SAMPLE_RATE,
    analyze_window_seconds,
    load_audio,
)


def test_defaults_when_unset() -> None:
    assert analyze_window_seconds({}) == ANALYZE_WINDOW_SECONDS_DEFAULT


def test_default_covers_ordinary_music_but_bounds_the_buffer() -> None:
    # Comfortably past any normal track (the library averages ~4 min)...
    assert ANALYZE_WINDOW_SECONDS_DEFAULT >= 600
    # ...while keeping the decode buffer to tens of MB, not GB.
    peak_bytes = ANALYZE_WINDOW_SECONDS_DEFAULT * SAMPLE_RATE * 4
    assert peak_bytes < 128 * 1024 * 1024


def test_the_file_that_caused_1048_is_now_bounded() -> None:
    # The real track: 30,915.56 s. Unwindowed that is ~1.98 GB (1.84 GiB) of PCM.
    unwindowed = 30_915.56 * SAMPLE_RATE * 4
    assert unwindowed > 1.9e9
    # Windowed, its cost is the same as every other track's.
    assert analyze_window_seconds({}) * SAMPLE_RATE * 4 < unwindowed / 20


def test_explicit_override_is_honoured() -> None:
    assert analyze_window_seconds({"ANALYSIS_ANALYZE_SECONDS": "120"}) == 120


def test_non_positive_never_disables_the_window() -> None:
    # `-t 0` would decode nothing and 422 the whole library.
    for sentinel in ("0", "-1", "-900"):
        assert analyze_window_seconds({"ANALYSIS_ANALYZE_SECONDS": sentinel}) == (
            ANALYZE_WINDOW_SECONDS_DEFAULT
        )


def test_garbage_falls_back_rather_than_raising() -> None:
    # A typo'd env var must not take the sidecar down at decode time.
    assert analyze_window_seconds({"ANALYSIS_ANALYZE_SECONDS": "forever"}) == (
        ANALYZE_WINDOW_SECONDS_DEFAULT
    )


class _FakeProc:
    returncode = 0
    stderr = b""
    # One second of silence: enough to clear load_audio's `< SAMPLE_RATE` guard.
    stdout = b"\0" * (SAMPLE_RATE * 4)


def test_load_audio_actually_passes_the_window_to_ffmpeg(monkeypatch) -> None:
    """The knob is worthless unless it reaches the argv — so assert the argv.

    A config function that returns the right number while the caller ignores it
    is the failure this guards: the whole defect was an ffmpeg invocation
    missing one flag.
    """
    seen: list[list[str]] = []

    def fake_run(argv, **_kwargs):
        seen.append(argv)
        return _FakeProc()

    monkeypatch.setattr(models.subprocess, "run", fake_run)
    monkeypatch.setenv("ANALYSIS_ANALYZE_SECONDS", "42")
    load_audio("/music/anything.opus")

    assert len(seen) == 1
    argv = seen[0]
    assert "-t" in argv, "the decode is unwindowed — this is the #1048 defect"
    assert argv[argv.index("-t") + 1] == "42.0"
    # `-t` must precede `-i` to be an INPUT option: ffmpeg then stops reading at
    # the window instead of decoding the whole file and discarding the tail.
    assert argv.index("-t") < argv.index("-i")
