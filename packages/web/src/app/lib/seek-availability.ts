/**
 * Seek-availability helpers — "can the media element satisfy this seek yet?".
 *
 * A forward seek past what the browser holds does not fail loudly: the element
 * silently clamps `currentTime` to the end of its seekable region and fires
 * `ended`. Downstream that is indistinguishable from a track finishing, so it
 * used to trip the false-ended recovery and restart the track at 0 — see
 * docs/web-ui.md "Seeking past the loaded region".
 *
 * Kept DI-free and free of `TimeRanges` in the value positions so they are
 * unit-testable without a real `<audio>` element (jsdom cannot construct a
 * `TimeRanges`).
 */

import type { BufferedRange } from './buffered-ranges';

/**
 * Tolerance (seconds) held back from a range's end before a seek into it is
 * accepted. Landing exactly on the last byte the browser holds makes it fire
 * `ended` instead of continuing, which is the failure this gate exists to
 * prevent — so treat the final half-second as not-yet-available.
 */
export const SEEK_AVAILABILITY_EPSILON_SEC = 0.5;

/** Snapshot a live `TimeRanges` (audio.seekable / audio.buffered) as plain data. */
export function timeRangesToArray(ranges: TimeRanges | null | undefined): BufferedRange[] {
  if (!ranges) return [];
  const out: BufferedRange[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const start = ranges.start(i);
    const end = ranges.end(i);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push({ start, end });
  }
  return out;
}

/** The furthest position any range reaches, or 0 when there is nothing to seek into. */
export function seekableEnd(ranges: BufferedRange[]): number {
  let end = 0;
  for (const r of ranges) {
    if (r.end > end) end = r.end;
  }
  return end;
}

/**
 * True when `target` lands inside a seekable range with {@link
 * SEEK_AVAILABILITY_EPSILON_SEC} to spare. A target the element cannot reach
 * yet is held as an intent and retried as data arrives, rather than assigned
 * and silently clamped.
 */
export function seekTargetIsAvailable(target: number, ranges: BufferedRange[]): boolean {
  if (!Number.isFinite(target) || target < 0) return false;
  return ranges.some((r) => target >= r.start && target <= r.end - SEEK_AVAILABILITY_EPSILON_SEC);
}
