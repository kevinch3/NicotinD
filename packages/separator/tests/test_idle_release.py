"""IdleReleaseGuard is copied from packages/analysis (framework-free, clock-injectable)."""

from app.idle_release import IdleReleaseGuard


class Clock:
    def __init__(self) -> None:
        self.t = 100.0

    def __call__(self) -> float:
        return self.t


def test_guard_is_idle_only_after_the_window() -> None:
    clock = Clock()
    guard = IdleReleaseGuard(60, now=clock)
    assert guard.is_idle() is False
    clock.t += 59
    assert guard.is_idle() is False
    clock.t += 1
    assert guard.is_idle() is True


def test_touch_resets_the_window() -> None:
    clock = Clock()
    guard = IdleReleaseGuard(60, now=clock)
    clock.t += 59
    guard.touch()
    clock.t += 59
    assert guard.is_idle() is False


def test_non_positive_window_disables_release() -> None:
    clock = Clock()
    guard = IdleReleaseGuard(0, now=clock)
    clock.t += 1e9
    assert guard.is_idle() is False
