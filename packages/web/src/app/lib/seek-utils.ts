/**
 * Fraction of a track elapsed, as a 0..100 percentage. Drives the seek bar's
 * filled-track gradient (`app-seek-bar`, the native-range seek control). Kept
 * DI-free so it can be unit-tested without instantiating the component (the web
 * JIT harness can't drive `input()` signals).
 *
 * (The old pointer→time math — `seekFraction`/`seekTime`/`pointerSeekTime` — was
 * removed when the bespoke `<div>` seek bar became a native `<input type=range>`,
 * which owns click/drag/touch position internally.)
 */
export function seekPercent(position: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const pct = (Math.max(0, position) / duration) * 100;
  return Math.max(0, Math.min(100, pct));
}
