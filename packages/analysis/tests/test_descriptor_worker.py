"""The descriptor extraction runs in a separate worker PROCESS, not a thread.

Why (measured on prod, v0.3.61): Essentia's bindings hold the GIL for the
whole MusicExtractor call (~5 s), so while a track was being analysed the
sidecar's own /health took 5–7 s — past the API client's 5 s probe timeout
and Docker's healthcheck — and the availability gate flapped for the entire
backfill. A process has its own GIL; the parent stays free to answer.

These tests drive the runner with plain picklable functions — no Essentia.
"""

import os

import pytest

from app.descriptors import DescriptorUnavailableError, ProcessRunner


def add(a: int, b: int) -> int:
    return a + b


def die() -> None:
    os._exit(3)  # kills the worker without raising — a crash, not an exception


def boom() -> None:
    raise ValueError("bad file")


def test_runner_executes_in_a_worker_and_returns_the_result() -> None:
    runner = ProcessRunner()
    try:
        assert runner.run(add, 2, 3) == 5
        assert runner.run(add, 10, -4) == 6  # the worker is reused, not respawned
    finally:
        runner.shutdown()


def test_runner_runs_outside_the_parent_process() -> None:
    runner = ProcessRunner()
    try:
        assert runner.run(os.getpid) != os.getpid()
    finally:
        runner.shutdown()


def test_worker_exceptions_propagate_as_themselves() -> None:
    # A per-file failure inside the worker must still reach the endpoint as an
    # ordinary exception (→ 422), not be mistaken for a dead worker (→ 503).
    runner = ProcessRunner()
    try:
        with pytest.raises(ValueError):
            runner.run(boom)
    finally:
        runner.shutdown()


def test_a_dead_worker_is_reported_unavailable_then_replaced() -> None:
    runner = ProcessRunner()
    try:
        with pytest.raises(DescriptorUnavailableError):
            runner.run(die)
        # The next call must not be poisoned by the broken pool.
        assert runner.run(add, 1, 1) == 2
    finally:
        runner.shutdown()
