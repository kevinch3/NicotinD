/**
 * Map a pointer's horizontal position over a seek bar to a 0..1 fraction of the
 * track. Shared by the desktop mini-player bar and the Now Playing sheet bar so
 * tap-to-seek and drag-scrub use identical math. Clamped to [0, 1].
 */
export function seekFraction(clientX: number, rectLeft: number, rectWidth: number): number {
  if (rectWidth <= 0) return 0;
  return Math.max(0, Math.min(1, (clientX - rectLeft) / rectWidth));
}

/** Convert a 0..1 seek fraction to an absolute time in seconds for a duration. */
export function seekTime(fraction: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(0, Math.min(1, fraction)) * duration;
}

/**
 * Pointer position over a seek bar → absolute seek time. The composition every
 * seek bar uses (desktop mini-player, mobile mini-player edge bar, Now Playing).
 */
export function pointerSeekTime(
  clientX: number,
  rect: { left: number; width: number },
  duration: number,
): number {
  return seekTime(seekFraction(clientX, rect.left, rect.width), duration);
}
