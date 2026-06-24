import { describe, expect, it } from 'bun:test';
import { isWithinWindow, parseHhMm, formatWindow } from './processing-window.js';

function at(h: number, m = 0): Date {
  const d = new Date(2024, 0, 1, h, m, 0, 0);
  return d;
}

describe('parseHhMm', () => {
  it('parses valid HH:MM to minutes', () => {
    expect(parseHhMm('00:00')).toBe(0);
    expect(parseHhMm('05:30')).toBe(330);
    expect(parseHhMm('23:59')).toBe(1439);
    expect(parseHhMm('5:00')).toBe(300);
  });

  it('rejects malformed or out-of-range values', () => {
    expect(parseHhMm('24:00')).toBeNull();
    expect(parseHhMm('12:60')).toBeNull();
    expect(parseHhMm('abc')).toBeNull();
    expect(parseHhMm('')).toBeNull();
    expect(parseHhMm('1200')).toBeNull();
  });
});

describe('isWithinWindow', () => {
  const day = { start: '05:00', end: '08:00' };

  it('is inside between start (inclusive) and end (exclusive)', () => {
    expect(isWithinWindow(at(5, 0), day)).toBe(true); // start boundary inclusive
    expect(isWithinWindow(at(6, 30), day)).toBe(true);
    expect(isWithinWindow(at(7, 59), day)).toBe(true);
  });

  it('is outside before start and at/after end', () => {
    expect(isWithinWindow(at(4, 59), day)).toBe(false);
    expect(isWithinWindow(at(8, 0), day)).toBe(false); // end boundary exclusive
    expect(isWithinWindow(at(20, 0), day)).toBe(false);
  });

  it('handles a window crossing midnight', () => {
    const night = { start: '23:00', end: '02:00' };
    expect(isWithinWindow(at(23, 0), night)).toBe(true);
    expect(isWithinWindow(at(23, 59), night)).toBe(true);
    expect(isWithinWindow(at(0, 30), night)).toBe(true);
    expect(isWithinWindow(at(1, 59), night)).toBe(true);
    expect(isWithinWindow(at(2, 0), night)).toBe(false); // end exclusive
    expect(isWithinWindow(at(12, 0), night)).toBe(false);
  });

  it('treats an empty (start === end) window as never', () => {
    expect(isWithinWindow(at(12, 0), { start: '12:00', end: '12:00' })).toBe(false);
  });

  it('fails closed on malformed bounds', () => {
    expect(isWithinWindow(at(6, 0), { start: 'oops', end: '08:00' })).toBe(false);
    expect(isWithinWindow(at(6, 0), { start: '05:00', end: '99:99' })).toBe(false);
  });
});

describe('formatWindow', () => {
  it('renders an en-dash range', () => {
    expect(formatWindow({ start: '05:00', end: '08:00' })).toBe('05:00–08:00');
  });
});
