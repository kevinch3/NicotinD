"""IdleReleaseGuard / RegistryHolder (issue #224) — the registry is dropped
after ANALYSIS_IDLE_RELEASE_SEC of no use and lazily reloaded on next use.
Mirrors test_device.py's injectable-clock style: a fake `now` drives the idle
window instead of real sleeps.
"""

from app.idle_release import IdleReleaseGuard, RegistryHolder


class FakeClock:
    def __init__(self, t: float = 0.0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


def test_guard_is_not_idle_before_the_window_elapses() -> None:
    clock = FakeClock()
    guard = IdleReleaseGuard(10.0, now=clock)
    clock.advance(5.0)
    assert guard.is_idle() is False


def test_guard_is_idle_once_the_window_elapses() -> None:
    clock = FakeClock()
    guard = IdleReleaseGuard(10.0, now=clock)
    clock.advance(10.0)
    assert guard.is_idle() is True


def test_touch_resets_the_idle_window() -> None:
    clock = FakeClock()
    guard = IdleReleaseGuard(10.0, now=clock)
    clock.advance(8.0)
    guard.touch()
    clock.advance(8.0)
    assert guard.is_idle() is False


def test_zero_or_negative_disables_release() -> None:
    clock = FakeClock()
    guard = IdleReleaseGuard(0.0, now=clock)
    clock.advance(10_000.0)
    assert guard.is_idle() is False
    assert IdleReleaseGuard(-1.0, now=clock).is_idle() is False


def test_holder_releases_only_after_idle_and_reloads_lazily() -> None:
    clock = FakeClock()
    guard = IdleReleaseGuard(10.0, now=clock)
    reloaded = object()
    holder = RegistryHolder(initial="first", factory=lambda: reloaded, guard=guard)

    assert holder.is_loaded() is True
    assert holder.release_if_idle() is False  # not idle yet

    clock.advance(10.0)
    assert holder.release_if_idle() is True
    assert holder.is_loaded() is False
    # A second sweep while already released is a no-op, not a double-drop.
    assert holder.release_if_idle() is False

    # Next use reloads via the factory, not the original value.
    assert holder.get() is reloaded
    assert holder.is_loaded() is True


def test_holder_get_touches_the_guard_so_use_delays_the_next_release() -> None:
    clock = FakeClock()
    guard = IdleReleaseGuard(10.0, now=clock)
    holder = RegistryHolder(initial="reg", factory=lambda: "reg", guard=guard)

    clock.advance(9.0)
    holder.get()  # a use just under the window — must not count as idle
    clock.advance(9.0)
    assert holder.release_if_idle() is False
    clock.advance(2.0)
    assert holder.release_if_idle() is True


def test_holder_never_reloads_a_registry_that_failed_at_startup() -> None:
    """`initial=None` not caused by this holder's own release — `get()` must
    not call the factory, matching the pre-existing '503 forever' contract."""
    clock = FakeClock()
    guard = IdleReleaseGuard(10.0, now=clock)
    calls = 0

    def factory() -> None:
        nonlocal calls
        calls += 1

    holder = RegistryHolder(initial=None, factory=factory, guard=guard)
    assert holder.get() is None
    assert calls == 0


def test_holder_set_replaces_the_value_directly() -> None:
    clock = FakeClock()
    guard = IdleReleaseGuard(10.0, now=clock)
    holder = RegistryHolder(initial=None, factory=lambda: None, guard=guard)
    holder.set("loaded-at-boot")
    assert holder.is_loaded() is True
    assert holder.get() == "loaded-at-boot"


def test_holder_peek_does_not_touch_the_guard() -> None:
    """Regression (verified on prod host `kpc`): Docker's healthcheck polls
    `/health` every 30s. `/health` used to call `get()`, which touches the
    guard on every call — so with `ANALYSIS_IDLE_RELEASE_SEC=900` (the
    default), the healthcheck alone kept the registry "in use" forever and it
    never idle-released in production. `peek()` must not reset the timer."""
    clock = FakeClock()
    guard = IdleReleaseGuard(10.0, now=clock)
    holder = RegistryHolder(initial="reg", factory=lambda: "reg", guard=guard)

    # Simulate a healthcheck hitting /health every 3 "seconds" via peek() —
    # far more often than the 10s idle window — right up to the boundary.
    for _ in range(3):
        clock.advance(3.0)
        assert holder.peek() == "reg"

    clock.advance(1.0)  # now at 10.0 total: past the idle window
    assert holder.release_if_idle() is True


def test_holder_peek_does_not_reload_an_idle_dropped_registry() -> None:
    """Unlike `get()`, `peek()` must not resurrect a released registry — a
    health check reading `None` back is correct ("unavailable"); reloading it
    just to answer a health probe would undo the idle release immediately."""
    clock = FakeClock()
    guard = IdleReleaseGuard(10.0, now=clock)
    calls = 0

    def factory() -> str:
        nonlocal calls
        calls += 1
        return "reloaded"

    holder = RegistryHolder(initial="reg", factory=factory, guard=guard)
    clock.advance(10.0)
    assert holder.release_if_idle() is True

    assert holder.peek() is None
    assert calls == 0
    assert holder.is_loaded() is False
