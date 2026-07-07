/**
 * Buffered-range helpers behind app-seek-bar's "loaded so far" band.
 *
 * The <audio> element reports `buffered` as TimeRanges in seconds; these
 * convert them into 0..100% segments and a CSS multi-stop gradient painted
 * under the seek fill (YouTube-style), so HDD users can tell a safe seek
 * target from one that will stall. Kept DI-free so they're unit-testable
 * without instantiating the component (the web JIT harness can't drive
 * input() signals).
 */

export interface BufferedRange {
  start: number;
  end: number;
}

export interface BufferedSegment {
  /** Left edge, 0..100 (% of duration). */
  left: number;
  /** Width, 0..100 (% of duration). */
  width: number;
}

/** Sub-0.5% segments are invisible at seek-bar widths — skip them. */
const MIN_SEGMENT_PERCENT = 0.5;

export function computeBufferedSegments(
  ranges: BufferedRange[],
  duration: number,
): BufferedSegment[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const segments: BufferedSegment[] = [];
  for (const r of ranges) {
    const start = Math.min(Math.max(0, r.start), duration);
    const end = Math.min(Math.max(0, r.end), duration);
    if (end <= start) continue;
    const left = (start / duration) * 100;
    const width = ((end - start) / duration) * 100;
    if (width < MIN_SEGMENT_PERCENT) continue;
    segments.push({ left, width });
  }
  return segments.sort((a, b) => a.left - b.left);
}

/**
 * Hard-stop gradient painting buffered segments (--seek-buffered-color) over
 * the base track (--theme-surface-2). Null when nothing is buffered — callers
 * fall back to the plain track background via the CSS var default.
 */
export function bufferedGradient(segments: BufferedSegment[]): string | null {
  if (segments.length === 0) return null;
  const base = 'var(--theme-surface-2)';
  const band = 'var(--seek-buffered-color)';
  const stops: string[] = [];
  for (const s of segments) {
    const start = s.left;
    const end = Math.min(100, s.left + s.width);
    stops.push(`${base} ${start}%`, `${band} ${start}%`, `${band} ${end}%`, `${base} ${end}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}
