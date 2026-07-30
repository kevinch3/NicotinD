"""GPU memory reduction (issue #224) — release the warm-loaded model registry
after a period of no `/analyze` calls, instead of holding the GPU allocation
forever.

Why this exists: TF's allocator (`TF_FORCE_GPU_ALLOW_GROWTH=true`) never
*shrinks* once it has grown — measured on the shared P4000 host, the sidecar
ratchets from ~85 MiB to 7,631 MiB of an 8,192 MiB card after the first
inference and holds it while completely idle (see
docs/audio-ml-enrichment.md "Measured GPU behaviour"). There is no
`memory_limit`/`ConfigProto` surface reachable through Essentia (it constructs
TF predictors directly), so a hard cap isn't available — dropping the Python
object and letting the process's next inference reconstruct it is the
mechanism that's actually reachable, at the cost of a multi-second reload on
the next `/analyze` after an idle release (acceptable: concurrency 1→8 makes no
measurable throughput difference, so occasional reload latency is cheap by the
same measurement).

`RegistryHolder` and `IdleReleaseGuard` are decoupled from FastAPI/asyncio on
purpose — both are plain, clock-injectable objects so tests drive the
idle→drop→reload cycle without a real background loop or real sleeps, mirroring
`cuda_device_count`'s injectable-loader style in `models.py`.
"""

from __future__ import annotations

import time as _time
from collections.abc import Callable
from typing import Generic, TypeVar

T = TypeVar("T")


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


class RegistryHolder(Generic[T]):
    """Owns one loaded object (a `ModelRegistry`) plus the idle-release guard,
    so the HTTP handler and the background watcher share a single drop/reload
    decision path instead of duplicating the "was this idle-dropped or never
    loaded" distinction.

    A registry that failed to load at startup (`initial=None`, never dropped by
    this holder) stays `None` forever — `get()` never attempts a reload for
    that case, matching the existing "503 while models are unavailable"
    contract. Only a registry this holder itself released gets reloaded.
    """

    def __init__(
        self,
        initial: T | None,
        factory: Callable[[], T | None],
        guard: IdleReleaseGuard,
    ) -> None:
        self._value = initial
        self._factory = factory
        # Public: the FastAPI test seam (`app.state.registry_holder.guard`)
        # reaches in to tweak `idle_release_sec` without a real clock/sleep.
        self.guard = guard
        self._idle_dropped = False

    def get(self) -> T | None:
        """The current value for use, reloading first if it was idle-dropped."""
        if self._value is None and self._idle_dropped:
            self._value = self._factory()
            self._idle_dropped = False
        if self._value is not None:
            self.guard.touch()
        return self._value

    def is_loaded(self) -> bool:
        return self._value is not None

    def set(self, value: T | None) -> None:
        """Replace the held value directly — used for the initial boot load,
        which happens outside the drop/reload cycle this class otherwise owns."""
        self._value = value
        self._idle_dropped = False

    def release_if_idle(self) -> bool:
        """Drop the value if idle. Returns whether a release happened."""
        if self._value is not None and self.guard.is_idle():
            self._value = None
            self._idle_dropped = True
            return True
        return False
