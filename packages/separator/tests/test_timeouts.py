from app.timeouts import separate_timeout_sec


def test_timeout_is_floored_for_short_tracks() -> None:
    assert separate_timeout_sec(30) == 120


def test_timeout_scales_with_duration_at_roughly_four_times_the_measured_rtf() -> None:
    # RTF 0.261 measured; 1.0x + 60 s leaves a wide margin for a cold worker.
    assert separate_timeout_sec(210) == 270
    assert separate_timeout_sec(600) == 660
