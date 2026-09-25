import { describe, expect, it } from 'vitest';
import { formatTime } from './format-time';

describe('formatTime', () => {
  it('renders m:ss with a zero-padded second field', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(72.9)).toBe('1:12');
    expect(formatTime(220)).toBe('3:40');
    expect(formatTime(3725)).toBe('62:05');
  });

  it('falls back to 0:00 for NaN, Infinity and negative input', () => {
    expect(formatTime(NaN)).toBe('0:00');
    expect(formatTime(Infinity)).toBe('0:00');
    expect(formatTime(-3)).toBe('0:00');
  });
});
