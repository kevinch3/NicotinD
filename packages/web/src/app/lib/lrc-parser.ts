/**
 * Pure helpers for synced (LRC) lyrics. Kept DI-free so the line-timing logic is
 * unit-testable without driving Angular `input()` signals (which the JIT vitest
 * harness can't do). The now-playing view feeds `parseLrc` the raw LRC and asks
 * `findActiveLine` which line to highlight for the current playback position.
 */

export interface LyricLine {
  /** Timestamp in milliseconds from the start of the track. */
  timeMs: number;
  text: string;
}

// [mm:ss.xx] / [mm:ss.xxx] / [mm:ss] — one or more may prefix a single line.
const TIMESTAMP = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/**
 * Parse raw LRC text into time-sorted lines. Lines may carry multiple
 * timestamps (repeated chorus) — each becomes its own entry. ID tags like
 * `[ar:...]` / `[ti:...]` (non-numeric) are ignored, and lines with no timestamp
 * are dropped. Returns [] for empty/unsynced input.
 */
export function parseLrc(raw: string | null | undefined): LyricLine[] {
  if (!raw) return [];
  const out: LyricLine[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    TIMESTAMP.lastIndex = 0;
    const stamps: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = TIMESTAMP.exec(rawLine)) !== null) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      // A 2-digit fraction is centiseconds, a 3-digit one is milliseconds.
      const frac = m[3] ?? '';
      const ms = frac.length === 3 ? Number(frac) : Number(frac.padEnd(2, '0')) * 10;
      stamps.push(min * 60_000 + sec * 1000 + (Number.isFinite(ms) ? ms : 0));
    }
    if (stamps.length === 0) continue;
    const text = rawLine.replace(TIMESTAMP, '').trim();
    for (const timeMs of stamps) out.push({ timeMs, text });
  }
  return out.sort((a, b) => a.timeMs - b.timeMs);
}

/**
 * Index of the line that should be highlighted at `currentMs`: the last line
 * whose timestamp is at or before the current position. Returns -1 before the
 * first line. `lines` must be time-sorted (as `parseLrc` returns them).
 */
export function findActiveLine(lines: LyricLine[], currentMs: number): number {
  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.timeMs <= currentMs) active = i;
    else break;
  }
  return active;
}
