import { describe, expect, it } from 'vitest';
import { parseLrc } from '@nicotind/core';
import {
  activeTimingRow,
  canSaveTiming,
  clearRow,
  formatTimingStamp,
  fromHereToEnd,
  nextUnstamped,
  retextRow,
  rowsFromLyrics,
  shiftRows,
  stampRow,
  stampedCount,
  timingPayload,
  type TimingRow,
} from './lyrics-timing-draft';

const rows = (...times: Array<number | null>): TimingRow[] =>
  times.map((timeMs, i) => ({ text: `line ${i + 1}`, timeMs }));

describe('rowsFromLyrics', () => {
  it('loads a timed row with the sync offset folded in', () => {
    const got = rowsFromLyrics({
      plain: 'a\nb',
      synced: '[00:01.00]a\n[00:05.00]b',
      offsetMs: 250,
    });
    expect(got).toEqual([
      { text: 'a', timeMs: 1250 },
      { text: 'b', timeMs: 5250 },
    ]);
  });

  it('loads a plain row as unstamped lines, dropping blank ones', () => {
    const got = rowsFromLyrics({ plain: 'a\n\n  b  \r\nc', synced: null, offsetMs: 0 });
    expect(got).toEqual([
      { text: 'a', timeMs: null },
      { text: 'b', timeMs: null },
      { text: 'c', timeMs: null },
    ]);
  });

  it('is empty for no row', () => {
    expect(rowsFromLyrics(null)).toEqual([]);
  });
});

describe('stamping', () => {
  it('nextUnstamped finds the first unstamped row from a position, else -1', () => {
    expect(nextUnstamped(rows(1000, null, 3000, null))).toBe(1);
    expect(nextUnstamped(rows(1000, null, 3000, null), 2)).toBe(3);
    expect(nextUnstamped(rows(1000, 2000))).toBe(-1);
  });

  it('stampRow sets one row and leaves the input untouched', () => {
    const before = rows(null, null);
    const after = stampRow(before, 1, 4321.4);
    expect(after.map((r) => r.timeMs)).toEqual([null, 4321]);
    expect(before.map((r) => r.timeMs)).toEqual([null, null]);
  });

  it('clearRow removes a stamp, which is what Undo does', () => {
    expect(clearRow(rows(1000, 2000), 1).map((r) => r.timeMs)).toEqual([1000, null]);
  });

  it('stampedCount counts stamped rows', () => {
    expect(stampedCount(rows(1000, null, 3000))).toBe(2);
  });
});

describe('moving stamps', () => {
  it('shiftRows moves only the chosen, stamped rows', () => {
    const got = shiftRows(rows(1000, 2000, null, 4000), [1, 2, 3], 500);
    expect(got.map((r) => r.timeMs)).toEqual([1000, 2500, null, 4500]);
  });

  it('never moves a stamp before zero', () => {
    expect(shiftRows(rows(200), [0], -500)[0]!.timeMs).toBe(0);
  });

  it('fromHereToEnd is every row from the index on', () => {
    expect(fromHereToEnd(rows(1, 2, 3, 4), 2)).toEqual([2, 3]);
  });

  it('retextRow changes the words and keeps the stamp', () => {
    expect(retextRow(rows(1000), 0, 'fixed')[0]).toEqual({ text: 'fixed', timeMs: 1000 });
  });
});

describe('saving', () => {
  it('needs a stamp on every non-empty line', () => {
    expect(canSaveTiming(rows(1000, 2000))).toBe(true);
    expect(canSaveTiming(rows(1000, null))).toBe(false);
    expect(canSaveTiming([])).toBe(false);
    expect(
      canSaveTiming([
        { text: 'a', timeMs: 1000 },
        { text: '   ', timeMs: null },
      ]),
    ).toBe(true);
  });

  it('builds the PUT body: words joined by newlines and an LRC parseLrc reads back', () => {
    const body = timingPayload([
      { text: ' second ', timeMs: 5000 },
      { text: 'first', timeMs: 1250 },
      { text: '', timeMs: 9000 },
    ]);
    expect(body.plain).toBe('first\nsecond');
    expect(body.synced).toBe('[00:01.25]first\n[00:05.00]second');
    expect(parseLrc(body.synced)).toEqual([
      { timeMs: 1250, text: 'first' },
      { timeMs: 5000, text: 'second' },
    ]);
  });
});

describe('preview and display', () => {
  it('activeTimingRow is the last stamped row at or before the time', () => {
    const r = rows(1000, null, 3000);
    expect(activeTimingRow(r, 500)).toBe(-1);
    expect(activeTimingRow(r, 1000)).toBe(0);
    expect(activeTimingRow(r, 2999)).toBe(0);
    expect(activeTimingRow(r, 9000)).toBe(2);
  });

  it('follows the times, not the row order, when a row was stamped out of order', () => {
    expect(activeTimingRow(rows(5000, 1000), 2000)).toBe(1);
  });

  it('formats a stamp as mm:ss.cc and an unstamped row as a dash', () => {
    expect(formatTimingStamp(19_260)).toBe('00:19.26');
    expect(formatTimingStamp(61_005)).toBe('01:01.01');
    expect(formatTimingStamp(null)).toBe('—:—');
  });
});
