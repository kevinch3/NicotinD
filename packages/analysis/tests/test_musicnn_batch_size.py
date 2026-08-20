"""musicnn_batch_size(): the bound that keeps MusiCNN off the whole GPU.

Left at Essentia's default the MusiCNN predictor allocated 7.4 GB of workspace
to produce a 216x200 array — measured on a Quadro P4000, it took the sidecar's
whole footprint from 2,235 MiB to 7,631 MiB of an 8,192 MiB card and never gave
it back, which is what made the card unshareable. The value reaching Essentia
must therefore always be a positive integer: 0 and -1 are Essentia's "accumulate
every patch" sentinels, i.e. exactly the unbounded behaviour being prevented.
"""

from app.models import MUSICNN_BATCH_SIZE_DEFAULT, musicnn_batch_size


def test_defaults_when_unset() -> None:
    assert musicnn_batch_size({}) == MUSICNN_BATCH_SIZE_DEFAULT


def test_default_is_bounded_and_positive() -> None:
    assert 0 < MUSICNN_BATCH_SIZE_DEFAULT <= 16


def test_explicit_override_is_honoured() -> None:
    assert musicnn_batch_size({"ANALYSIS_MUSICNN_BATCH_SIZE": "16"}) == 16


def test_accumulate_all_sentinels_never_reach_essentia() -> None:
    # 0 and -1 are Essentia's "store every patch, run one session" values.
    for sentinel in ("0", "-1"):
        assert musicnn_batch_size({"ANALYSIS_MUSICNN_BATCH_SIZE": sentinel}) == (
            MUSICNN_BATCH_SIZE_DEFAULT
        )


def test_garbage_falls_back_rather_than_raising() -> None:
    # A typo'd env var must not take the sidecar down at construction time.
    assert musicnn_batch_size({"ANALYSIS_MUSICNN_BATCH_SIZE": "lots"}) == (
        MUSICNN_BATCH_SIZE_DEFAULT
    )
