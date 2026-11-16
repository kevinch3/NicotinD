import { applyLyricsOffset, parseLrc, serializeLrc } from '@nicotind/core';
import type { LyricsDto } from '@nicotind/core';

/**
 * The timing editor's draft (#1675, docs/lyrics-options.md §4): the lines of a
 * song with the playback time each one starts at, or null while unstamped.
 * Every function returns a new array; nothing here touches the DOM or a clock.
 */
export interface TimingRow {
  text: string;
  /** Absolute playback time in ms; null until the line is stamped. */
  timeMs: number | null;
}

/**
 * Rows for a stored lyrics row. A timed row loads with its sync offset folded
 * in, which is what karaoke shows, so the saved LRC needs no offset. A plain
 * row loads its non-empty lines unstamped.
 */
export function rowsFromLyrics(
  lyrics: Pick<LyricsDto, 'plain' | 'synced' | 'offsetMs'> | null,
): TimingRow[] {
  if (!lyrics) return [];
  const timed = applyLyricsOffset(parseLrc(lyrics.synced), lyrics.offsetMs);
  if (timed.length > 0) return timed.map((l) => ({ text: l.text, timeMs: l.timeMs }));
  return (lyrics.plain ?? '')
    .split(/\r?\n/)
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .map((text) => ({ text, timeMs: null }));
}

/** The line a stamp goes to next: the first unstamped one from `from`, else none. */
export function nextUnstamped(rows: readonly TimingRow[], from = 0): number {
  for (let i = Math.max(0, from); i < rows.length; i++) {
    if (rows[i]!.timeMs === null) return i;
  }
  return -1;
}

const atLeastZero = (ms: number) => Math.max(0, Math.round(ms));

/** Give row `index` the time `timeMs`. */
export function stampRow(rows: readonly TimingRow[], index: number, timeMs: number): TimingRow[] {
  return rows.map((r, i) => (i === index ? { ...r, timeMs: atLeastZero(timeMs) } : r));
}

/** Remove row `index`'s stamp. */
export function clearRow(rows: readonly TimingRow[], index: number): TimingRow[] {
  return rows.map((r, i) => (i === index ? { ...r, timeMs: null } : r));
}

/** Move the stamped rows among `indices` by `deltaMs`; unstamped ones stay unstamped. */
export function shiftRows(
  rows: readonly TimingRow[],
  indices: Iterable<number>,
  deltaMs: number,
): TimingRow[] {
  const chosen = new Set(indices);
  return rows.map((r, i) =>
    chosen.has(i) && r.timeMs !== null ? { ...r, timeMs: atLeastZero(r.timeMs + deltaMs) } : r,
  );
}

/** Every index from `index` to the last row: "from here to the end". */
export function fromHereToEnd(rows: readonly TimingRow[], index: number): number[] {
  return rows.map((_, i) => i).filter((i) => i >= index);
}

/** Replace row `index`'s words, keeping its stamp. */
export function retextRow(rows: readonly TimingRow[], index: number, text: string): TimingRow[] {
  return rows.map((r, i) => (i === index ? { ...r, text } : r));
}

export function stampedCount(rows: readonly TimingRow[]): number {
  return rows.filter((r) => r.timeMs !== null).length;
}

/**
 * A draft may be saved when it has words and every non-empty line is stamped
 * (owner decision 6): a half-timed LRC would drop the unstamped lines.
 */
export function canSaveTiming(rows: readonly TimingRow[]): boolean {
  const worded = rows.filter((r) => r.text.trim().length > 0);
  return worded.length > 0 && worded.every((r) => r.timeMs !== null);
}

/** The body `PUT …/lyrics` takes: the words, and the LRC with absolute times. */
export function timingPayload(rows: readonly TimingRow[]): { plain: string; synced: string } {
  const stamped = rows.filter(
    (r): r is TimingRow & { timeMs: number } => r.timeMs !== null && r.text.trim().length > 0,
  );
  const ordered = [...stamped].sort((a, b) => a.timeMs - b.timeMs);
  return {
    plain: ordered.map((r) => r.text.trim()).join('\n'),
    synced: serializeLrc(ordered.map((r) => ({ timeMs: r.timeMs, text: r.text.trim() }))),
  };
}

/** The row playing at `timeMs`: the last stamped row at or before it, else -1. */
export function activeTimingRow(rows: readonly TimingRow[], timeMs: number): number {
  let best = -1;
  let bestTime = -1;
  rows.forEach((r, i) => {
    if (r.timeMs !== null && r.timeMs <= timeMs && r.timeMs >= bestTime) {
      best = i;
      bestTime = r.timeMs;
    }
  });
  return best;
}

/** `mm:ss.cc` for a row's stamp. */
export function formatTimingStamp(timeMs: number | null): string {
  if (timeMs === null) return '—:—';
  const total = Math.max(0, Math.round(timeMs / 10));
  const min = Math.floor(total / 6000);
  const sec = Math.floor((total % 6000) / 100);
  const cs = total % 100;
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(min)}:${two(sec)}.${two(cs)}`;
}
