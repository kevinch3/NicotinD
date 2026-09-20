import { describe, it, expect } from 'bun:test';
import {
  parseLrc,
  parseLrcDetailed,
  applyLyricsOffset,
  findActiveLine,
  type LyricLine,
} from './lrc.js';

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

/**
 * The LRC spec's own `[offset:±ms]` tag, which this parser ignored until
 * issue #1212's follow-up. A `+` value means the lyrics should appear *sooner*,
 * so it is SUBTRACTED from every timestamp — the opposite sign to the stored
 * user offset, which is added. Any fetched LRC carrying the tag was being
 * rendered at the wrong time before this, independently of any user correction.
 */
describe('parseLrc honours the file [offset:] tag', () => {
  it('shifts lines earlier for a positive offset', () => {
    expect(parseLrc('[offset:+500]\n[00:10.00]Line')).toEqual([{ timeMs: 9_500, text: 'Line' }]);
  });

  it('shifts lines later for a negative offset', () => {
    expect(parseLrc('[offset:-500]\n[00:10.00]Line')).toEqual([{ timeMs: 10_500, text: 'Line' }]);
  });

  it('accepts an unsigned value and surrounding whitespace', () => {
    expect(parseLrc('[offset: 250 ]\n[00:10.00]Line')).toEqual([{ timeMs: 9_750, text: 'Line' }]);
  });

  it('ignores a malformed offset rather than throwing or zeroing the line', () => {
    expect(parseLrc('[offset:soon]\n[00:10.00]Line')).toEqual([{ timeMs: 10_000, text: 'Line' }]);
  });

  it('keeps a negative effective time rather than clamping it to zero', () => {
    // Clamping would silently collapse the opening lines onto one another; a
    // rigid translation is recoverable, a clamped one is not.
    expect(parseLrc('[offset:+5000]\n[00:01.00]Early')).toEqual([
      { timeMs: -4_000, text: 'Early' },
    ]);
  });

  it('reports the tag separately via parseLrcDetailed', () => {
    const parsed = parseLrcDetailed('[offset:+500]\n[00:10.00]Line');
    expect(parsed.fileOffsetMs).toBe(500);
    expect(parsed.lines).toEqual([{ timeMs: 9_500, text: 'Line' }]);
  });

  it('reports a zero file offset when the tag is absent', () => {
    expect(parseLrcDetailed('[00:10.00]Line').fileOffsetMs).toBe(0);
  });
});

/**
 * The stored, human-set correction. Positive means "show the lines LATER" —
 * one convention, fixed here, that every sign question in the UI and the MCP
 * tool resolves against.
 */
describe('applyLyricsOffset', () => {
  const lines: LyricLine[] = [
    { timeMs: 1_000, text: 'One' },
    { timeMs: 2_000, text: 'Two' },
    { timeMs: 3_000, text: 'Three' },
  ];

  it('moves every line later for a positive offset', () => {
    expect(applyLyricsOffset(lines, 500).map((l) => l.timeMs)).toEqual([1_500, 2_500, 3_500]);
  });

  it('moves every line earlier for a negative offset', () => {
    expect(applyLyricsOffset(lines, -500).map((l) => l.timeMs)).toEqual([500, 1_500, 2_500]);
  });

  it('is identity at zero and does not mutate its input', () => {
    expect(applyLyricsOffset(lines, 0)).toEqual(lines);
    applyLyricsOffset(lines, 9_000);
    expect(lines[0]!.timeMs).toBe(1_000);
  });

  it('is a rigid translation: order, count and text are untouched', () => {
    const shifted = applyLyricsOffset(lines, -10_000);
    expect(shifted).toHaveLength(lines.length);
    expect(shifted.map((l) => l.text)).toEqual(['One', 'Two', 'Three']);
    for (let i = 1; i < shifted.length; i++) {
      expect(shifted[i]!.timeMs).toBeGreaterThan(shifted[i - 1]!.timeMs);
    }
  });

  it('composes with the file tag: the two offsets add up, with opposite signs', () => {
    // File says "500ms sooner", the user says "200ms later" → net 300ms sooner.
    const parsed = parseLrc('[offset:+500]\n[00:10.00]Line');
    expect(applyLyricsOffset(parsed, 200)).toEqual([{ timeMs: 9_700, text: 'Line' }]);
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

  it('follows an offset: the same position highlights a different line', () => {
    // What makes the nudge control work — the highlight moves without the text
    // being rewritten.
    expect(findActiveLine(applyLyricsOffset(lines, 5_000), 10_000)).toBe(0);
  });
});
