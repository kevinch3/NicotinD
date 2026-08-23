/**
 * Pure geometry for the Now Playing waveform + karaoke VFX (issue #643). Kept
 * DI-free so the maths is unit-tested without a DOM — the components only map
 * these onto an SVG `d` attribute and canvas draw calls (the
 * `radar-geometry.ts` pattern; the JIT vitest harness can't drive `input()`).
 */

/** Band count is fixed by the server contract (six perceptual bands). */
export const BAND_COUNT = 6;

/** Silence still draws a hairline this tall (px), so the strip never vanishes. */
const MIN_HALF_PX = 0.5;

/**
 * Resample interleaved [min, max, …] pairs to `columns` pairs: merging keeps
 * the min of mins / max of maxes so a transient never disappears; stretching
 * repeats the nearest pair rather than inventing intermediate values.
 */
export function resamplePeaks(peaks: number[], columns: number): number[] {
  const n = Math.floor(peaks.length / 2);
  if (n === 0 || columns <= 0) return [];
  const out: number[] = [];
  for (let c = 0; c < columns; c++) {
    const start = Math.floor((c * n) / columns);
    const end = Math.max(start + 1, Math.floor(((c + 1) * n) / columns));
    let lo = Infinity;
    let hi = -Infinity;
    for (let p = start; p < end; p++) {
      lo = Math.min(lo, peaks[p * 2]!);
      hi = Math.max(hi, peaks[p * 2 + 1]!);
    }
    out.push(lo, hi);
  }
  return out;
}

/**
 * Closed SVG path of the min/max envelope: the max edge left→right along the
 * top, the min edge right→left along the bottom. Amplitude is linear in the
 * sample value (1 = the edge of the box); `columns` defaults to the width so
 * one column per pixel is the natural resolution.
 */
export function envelopePath(
  peaks: number[],
  width: number,
  height: number,
  columns = Math.max(1, Math.round(width)),
): string {
  const pairs = resamplePeaks(peaks, columns);
  const n = pairs.length / 2;
  if (n === 0) return '';
  const mid = height / 2;
  const step = n > 1 ? width / (n - 1) : 0;
  const r = (v: number): number => Math.round(v * 100) / 100;
  const yOf = (v: number, sign: 1 | -1): number => {
    const half = Math.max(MIN_HALF_PX, Math.abs(v) * mid);
    return Math.min(height, Math.max(0, mid - sign * half));
  };
  const top: string[] = [];
  const bottom: string[] = [];
  for (let i = 0; i < n; i++) {
    const x = r(n > 1 ? i * step : width / 2);
    top.push(`${i === 0 ? 'M' : 'L'}${x},${r(yOf(pairs[i * 2 + 1]!, 1))}`);
    bottom.push(`L${x},${r(yOf(pairs[i * 2]!, -1))}`);
  }
  return `${top.join(' ')} ${bottom.reverse().join(' ')} Z`;
}

/**
 * Band levels under the playhead: linear interpolation between the two
 * nearest frames, clamped at either end. An empty timeline yields silence
 * (six zeros) rather than throwing, so the VFX can run before the artifact
 * has loaded.
 */
export function bandLevelsAt(bands: number[][], frameRate: number, timeSec: number): number[] {
  if (bands.length === 0 || frameRate <= 0) return new Array<number>(BAND_COUNT).fill(0);
  const pos = Math.max(0, Math.min(bands.length - 1, timeSec * frameRate));
  const i = Math.floor(pos);
  const j = Math.min(bands.length - 1, i + 1);
  const t = pos - i;
  const a = bands[i]!;
  const b = bands[j]!;
  const out: number[] = [];
  for (let k = 0; k < BAND_COUNT; k++) {
    const va = a[k] ?? 0;
    const vb = b[k] ?? 0;
    out.push(va + (vb - va) * t);
  }
  return out;
}
