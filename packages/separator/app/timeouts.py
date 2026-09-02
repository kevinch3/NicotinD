"""Per-call bounds. The API's fetch timeout is the authority; these are the
sidecar's own backstops so a hung worker frees the GPU without a client."""

from __future__ import annotations

MIN_TRACK_SEC = 1.0
DEFAULT_MAX_TRACK_SEC = 900.0


def separate_timeout_sec(duration_sec: float) -> float:
    """~4x the measured RTF (0.261 on the P4000) plus a cold-start allowance."""
    return max(120.0, duration_sec * 1.0 + 60.0)
