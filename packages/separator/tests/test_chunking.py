"""Chunked inference windows + crossfaded overlap-add — pure numpy, no model."""

from itertools import pairwise

import numpy as np

from app.chunking import chunk_windows, crossfade_weights, overlap_add

CHUNK = 1000
OVERLAP = 100


def test_windows_cover_the_signal_exactly_once_with_the_overlap() -> None:
    windows = chunk_windows(3_250, chunk=CHUNK, overlap=OVERLAP)
    assert windows[0] == (0, 1000)
    assert windows[-1][1] == 3_250
    for (_, prev_end), (start, _) in pairwise(windows):
        assert prev_end - start == OVERLAP
    # Every consecutive pair overlaps by exactly OVERLAP; the last window is
    # short but always longer than the overlap it has to crossfade over.
    assert all(end - start > OVERLAP for start, end in windows)


def test_a_signal_shorter_than_one_chunk_is_a_single_window() -> None:
    assert chunk_windows(500, chunk=CHUNK, overlap=OVERLAP) == [(0, 500)]
    assert chunk_windows(CHUNK, chunk=CHUNK, overlap=OVERLAP) == [(0, CHUNK)]


def test_crossfade_weights_of_neighbours_sum_to_one_everywhere() -> None:
    n = 3_250
    windows = chunk_windows(n, chunk=CHUNK, overlap=OVERLAP)
    total = np.zeros(n)
    for i, (start, end) in enumerate(windows):
        total[start:end] += crossfade_weights(
            end - start, OVERLAP, fade_in=i > 0, fade_out=i < len(windows) - 1
        )
    assert np.allclose(total, 1.0)


def test_overlap_add_reconstructs_a_signal_split_into_windows() -> None:
    n = 3_250
    rng = np.random.default_rng(7)
    signal = rng.standard_normal((2, n)).astype(np.float32)
    windows = chunk_windows(n, chunk=CHUNK, overlap=OVERLAP)
    pieces = [signal[:, s:e] for s, e in windows]
    out = overlap_add(pieces, windows, n, OVERLAP)
    assert out.shape == (2, n)
    assert np.allclose(out, signal, atol=1e-6)


def test_pad_to_multiple_rounds_a_chunk_up_to_the_stft_hop() -> None:
    from app.chunking import pad_to_multiple

    chunk = np.ones((2, 866_156), dtype=np.float32)
    padded = pad_to_multiple(chunk, 512)
    assert padded.shape == (2, 866_304)
    assert padded[:, 866_156:].sum() == 0
    assert pad_to_multiple(np.ones((2, 1024), dtype=np.float32), 512).shape == (2, 1024)


def test_fit_length_trims_or_zero_pads_a_model_output_to_the_window() -> None:
    from app.chunking import fit_length

    # Measured on the P4000: the model returned 865,792 samples for an
    # 866,156-sample window (floor(n / hop) * hop). Never a crash — pad.
    short = np.ones((2, 865_792), dtype=np.float32)
    fitted = fit_length(short, 866_156)
    assert fitted.shape == (2, 866_156)
    assert fitted[:, 865_792:].sum() == 0
    assert fit_length(np.ones((2, 900_000), dtype=np.float32), 866_156).shape == (2, 866_156)
