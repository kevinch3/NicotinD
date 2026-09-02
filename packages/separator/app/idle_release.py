"""Idle-release timing, copied verbatim from packages/analysis/app/idle_release.py
(the guard half only — see below for why the holder half does not apply).

Why a copy and not a shared package: the two sidecars are separate images with
separate dependency stacks (TensorFlow vs torch); a shared Python package would
be a third artifact to version for 15 lines. Keep the two in sync by hand.

Why no `RegistryHolder`: in the analysis sidecar the model lives in the serving
process, so "release" means dropping a Python object (and, with TF, hoping the
allocator follows). Here the model lives in a spawned worker process — the
per-call timeout needs a process it can kill — so release means stopping that
process, which returns the model AND the CUDA context to the driver. That is
one `worker.stop()`; there is nothing to hold.
"""

from __future__ import annotations

import time as _time
from collections.abc import Callable


class IdleReleaseGuard:
    """Tracks elapsed time since the last `touch()`, in units of `now()`."""

    def __init__(self, idle_release_sec: float, now: Callable[[], float] = _time.monotonic) -> None:
        self.idle_release_sec = idle_release_sec
        self._now = now
        self._last_used = now()

    def touch(self) -> None:
        self._last_used = self._now()

    def is_idle(self) -> bool:
        """`idle_release_sec <= 0` disables release entirely (opt-out knob)."""
        if self.idle_release_sec <= 0:
            return False
        return (self._now() - self._last_used) >= self.idle_release_sec
