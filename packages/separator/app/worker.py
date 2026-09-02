"""One long-lived spawned worker process that owns the model and the CUDA
context, with the two things the analysis sidecar's `ProcessRunner` lacks:

- a per-call timeout that KILLS the worker (a `ProcessPoolExecutor` cannot
  cancel a running task, so a hung inference would hold the GPU until the
  container restarted), and
- `stop()`, called from the app's lifespan and by idle release — stopping the
  process is what actually returns VRAM (`del model` in-process never gives
  back the CUDA context).

Calls are serialised by one lock: the GPU is one resource. The parent stays
torch-free, so `/health` answers in milliseconds during a 55 s separation and
the parent never holds a CUDA context of its own. `spawn`, never `fork` — a
CUDA context does not survive a fork.
"""

from __future__ import annotations

import multiprocessing
import pickle
import threading
from collections.abc import Callable
from multiprocessing.connection import Connection
from typing import Any


class WorkerDied(RuntimeError):
    """The worker exited mid-call (OOM, segfault, kill) — environmental (503)."""


class SeparationTimeout(RuntimeError):
    """The call outlived its budget; the worker was killed — environmental (503)."""


def _worker_main(conn: Connection) -> None:
    while True:
        try:
            message = conn.recv()
        except EOFError:
            return
        if message is None:
            return
        fn, args = message
        try:
            conn.send(("ok", fn(*args)))
        except BaseException as err:  # noqa: BLE001 — every failure must reach the parent
            try:
                conn.send(("err", err))
            except (pickle.PicklingError, TypeError, AttributeError):  # unpicklable: send its repr
                conn.send(("err", RuntimeError(repr(err))))


class SeparationWorker:
    def __init__(self, ctx: multiprocessing.context.BaseContext | None = None) -> None:
        self._ctx = ctx or multiprocessing.get_context("spawn")
        self._lock = threading.Lock()
        self._proc: multiprocessing.process.BaseProcess | None = None
        self._conn: Connection | None = None

    def is_alive(self) -> bool:
        return self._proc is not None and self._proc.is_alive()

    def run(self, fn: Callable[..., Any], *args: Any, timeout_sec: float) -> Any:
        with self._lock:
            self._ensure()
            assert self._conn is not None
            try:
                self._conn.send((fn, args))
                if not self._conn.poll(timeout_sec):
                    self._kill()
                    raise SeparationTimeout(
                        f"separation exceeded {timeout_sec:.0f}s; worker killed"
                    )
                status, payload = self._conn.recv()
            except (EOFError, BrokenPipeError, ConnectionResetError, OSError) as err:
                self._kill()
                raise WorkerDied(f"separation worker died: {err!r}") from err
            if status == "err":
                raise payload
            return payload

    def stop(self) -> None:
        with self._lock:
            if self._proc is None:
                return
            try:
                if self._conn is not None and self._proc.is_alive():
                    self._conn.send(None)
                self._proc.join(5)
            except (BrokenPipeError, OSError):
                pass
            if self._proc.is_alive():
                self._proc.kill()
                self._proc.join(5)
            self._discard()

    def _ensure(self) -> None:
        if self.is_alive():
            return
        self._discard()
        parent, child = self._ctx.Pipe()
        proc = self._ctx.Process(target=_worker_main, args=(child,), daemon=True)
        proc.start()
        child.close()
        self._proc, self._conn = proc, parent

    def _kill(self) -> None:
        if self._proc is not None:
            self._proc.kill()
            self._proc.join(5)
        self._discard()

    def _discard(self) -> None:
        if self._conn is not None:
            try:
                self._conn.close()
            except OSError:
                pass
        self._proc, self._conn = None, None
