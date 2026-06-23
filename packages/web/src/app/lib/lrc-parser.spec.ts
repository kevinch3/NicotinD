import { describe, it, expect } from 'vitest';
import { parseLrc, findActiveLine } from './lrc-parser';

describe('parseLrc', () => {
  it('returns [] for empty/null input', () => {
    expect(parseLrc('')).toEqual([]);
    expect(parseLrc(null)).toEqual([]);
    expect(parseLrc(undefined)).toEqual([]);
  });

  it('parses centisecond timestamps to ms', () => {
    const lines = parseLrc('[00:12.34]Hello');
    expect(lines).toEqual([{ timeMs: 12_340, text: 'Hello' }]);
  });

  it('parses millisecond (3-digit) timestamps', () => {
    expect(parseLrc('[01:02.500]Line')).toEqual([{ timeMs: 62_500, text: 'Line' }]);
  });

  it('handles a timestamp with no fraction', () => {
    expect(parseLrc('[00:05]Tick')).toEqual([{ timeMs: 5_000, text: 'Tick' }]);
  });

  it('expands a line with multiple timestamps into separate entries', () => {
    const lines = parseLrc('[00:10.00][00:30.00]Chorus');
    expect(lines).toEqual([
      { timeMs: 10_000, text: 'Chorus' },
      { timeMs: 30_000, text: 'Chorus' },
    ]);
  });

  it('strips non-timestamp ID tags and drops untimed lines', () => {
    const lines = parseLrc('[ar:Artist]\n[ti:Title]\n[00:01.00]First');
    expect(lines).toEqual([{ timeMs: 1_000, text: 'First' }]);
  });

  it('sorts the result by time', () => {
    const lines = parseLrc('[00:20.00]Two\n[00:10.00]One');
    expect(lines.map((l) => l.text)).toEqual(['One', 'Two']);
  });

  it('keeps empty-text lines (instrumental breaks)', () => {
    expect(parseLrc('[00:03.00]')).toEqual([{ timeMs: 3_000, text: '' }]);
  });
});

describe('findActiveLine', () => {
  const lines = parseLrc('[00:00.00]A\n[00:10.00]B\n[00:20.00]C');

  it('returns -1 before the first line', () => {
    expect(findActiveLine(lines, -1)).toBe(-1);
  });

  it('returns the last line at or before the position', () => {
    expect(findActiveLine(lines, 0)).toBe(0);
    expect(findActiveLine(lines, 9_999)).toBe(0);
    expect(findActiveLine(lines, 10_000)).toBe(1);
    expect(findActiveLine(lines, 25_000)).toBe(2);
  });

  it('returns -1 for an empty list', () => {
    expect(findActiveLine([], 5_000)).toBe(-1);
  });
});
