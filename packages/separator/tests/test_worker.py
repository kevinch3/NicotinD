"""One spawned worker process, with the two things the analysis sidecar's
ProcessRunner lacks: a per-call timeout that kills the worker, and stop()."""

import os
import time

import pytest

from app.worker import SeparationTimeout, SeparationWorker, WorkerDied


def add(a: int, b: int) -> int:
    return a + b


def sleep_for(sec: float) -> str:
    time.sleep(sec)
    return "done"


def die() -> None:
    os._exit(3)


def boom() -> None:
    raise ValueError("bad file")


def test_runs_in_a_worker_and_reuses_it() -> None:
    worker = SeparationWorker()
    try:
        assert worker.run(add, 2, 3, timeout_sec=10) == 5
        first = worker.run(os.getpid, timeout_sec=10)
        assert first != os.getpid()
        assert worker.run(os.getpid, timeout_sec=10) == first
        assert worker.is_alive() is True
    finally:
        worker.stop()


def test_worker_exceptions_propagate_as_themselves() -> None:
    worker = SeparationWorker()
    try:
        with pytest.raises(ValueError, match="bad file"):
            worker.run(boom, timeout_sec=10)
        assert worker.run(add, 1, 1, timeout_sec=10) == 2
    finally:
        worker.stop()


def test_a_dead_worker_is_reported_then_replaced() -> None:
    worker = SeparationWorker()
    try:
        with pytest.raises(WorkerDied):
            worker.run(die, timeout_sec=10)
        assert worker.run(add, 1, 1, timeout_sec=10) == 2
    finally:
        worker.stop()


def test_timeout_kills_the_worker_and_the_next_call_works() -> None:
    worker = SeparationWorker()
    try:
        pid = worker.run(os.getpid, timeout_sec=10)
        with pytest.raises(SeparationTimeout):
            worker.run(sleep_for, 30, timeout_sec=0.5)
        assert worker.run(os.getpid, timeout_sec=10) != pid
    finally:
        worker.stop()


def test_stop_ends_the_process() -> None:
    worker = SeparationWorker()
    worker.run(add, 1, 1, timeout_sec=10)
    assert worker.is_alive() is True
    worker.stop()
    assert worker.is_alive() is False
