import { formatMb, formatBytes, diskFillColor, usedRatio } from './usage-pill';

describe('formatMb', () => {
  it('rounds under 100 MB to a whole MB', () => {
    expect(formatMb(95 * 1024 * 1024)).toBe('95 MB');
  });

  it('rounds at the 100 MB boundary without a stray decimal', () => {
    expect(formatMb(150 * 1024 * 1024)).toBe('150 MB');
  });

  it('returns 0 MB for non-positive input', () => {
    expect(formatMb(0)).toBe('0 MB');
    expect(formatMb(-5)).toBe('0 MB');
  });
});

describe('re-exports from disk-usage', () => {
  it('preserves formatBytes (canonical disk-pill formatter)', () => {
    expect(formatBytes(0)).toBe('0 GB');
    expect(formatBytes(95 * 1024 ** 3)).toBe('95.0 GB');
    expect(formatBytes(969 * 1024 ** 3)).toBe('969 GB');
  });

  it('preserves usedRatio clamping', () => {
    expect(usedRatio(50, 100)).toBe(0.5);
    expect(usedRatio(200, 100)).toBe(1);
    expect(usedRatio(10, 0)).toBe(0);
  });

  it('preserves diskFillColor (green→red palette)', () => {
    expect(diskFillColor(0)).toBe('hsl(140, 70%, 45%)');
    expect(diskFillColor(1)).toBe('hsl(0, 70%, 45%)');
    expect(diskFillColor(-1)).toBe('hsl(140, 70%, 45%)');
  });
});
