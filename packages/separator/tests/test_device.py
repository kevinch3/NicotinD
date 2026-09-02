"""CUDA SASS is forward-compatible within a compute-capability MAJOR version:
a kernel built for sm_60 runs on a 6.1 card, never the other way round (and
never across majors). The torch 2.13 cu126 wheel ships sm_50/sm_60/sm_70/...
with no sm_61 — the first build asserted the exact string and failed on the
very card it was meant to protect."""

from app.device import arch_supported

CU126_ARCHS = ["sm_50", "sm_60", "sm_70", "sm_75", "sm_80", "sm_86", "sm_90"]


def test_a_pascal_61_card_runs_sm_60_kernels() -> None:
    assert arch_supported((6, 1), CU126_ARCHS) is True


def test_exact_match_still_counts() -> None:
    assert arch_supported((7, 5), CU126_ARCHS) is True


def test_a_newer_minor_than_any_built_kernel_fails() -> None:
    # sm_89 (Ada) has no 8.x kernel at or below it? It does: sm_80/sm_86 — fine.
    assert arch_supported((8, 9), CU126_ARCHS) is True
    # But a 6.0 card cannot run sm_61-only builds, and 9.x needs a 9.0 kernel.
    assert arch_supported((6, 0), ["sm_61", "sm_70"]) is False
    assert arch_supported((9, 0), ["sm_80", "sm_86"]) is False


def test_majors_never_cross() -> None:
    assert arch_supported((6, 1), ["sm_50", "sm_70"]) is False


def test_garbage_entries_are_ignored() -> None:
    assert arch_supported((6, 1), ["compute_60", "sm_", "sm_6x", "sm_60"]) is True
