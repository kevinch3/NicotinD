import { formatBytes, usedRatio, diskFillColor } from './disk-usage';

describe('formatBytes', () => {
  it('formats zero/invalid as 0 GB', () => {
    expect(formatBytes(0)).toBe('0 GB');
    expect(formatBytes(-5)).toBe('0 GB');
    expect(formatBytes(NaN)).toBe('0 GB');
  });

  it('formats GB with one decimal under 100', () => {
    // 95 GiB
    expect(formatBytes(95 * 1024 ** 3)).toBe('95.0 GB');
  });

  it('drops decimals for large GB/TB values', () => {
    expect(formatBytes(969 * 1024 ** 3)).toBe('969 GB');
    expect(formatBytes(2 * 1024 ** 4)).toBe('2.0 TB');
  });

  it('uses whole units for MB and below', () => {
    expect(formatBytes(512 * 1024 * 1024)).toBe('512 MB');
    expect(formatBytes(4 * 1024)).toBe('4 KB');
  });
});

describe('usedRatio', () => {
  it('clamps into 0..1 and handles unknown total', () => {
    expect(usedRatio(50, 100)).toBe(0.5);
    expect(usedRatio(200, 100)).toBe(1);
    expect(usedRatio(-5, 100)).toBe(0);
    expect(usedRatio(10, 0)).toBe(0);
  });
});

describe('diskFillColor', () => {
  it('is green when empty and red when full', () => {
    expect(diskFillColor(0)).toBe('hsl(140, 70%, 45%)');
    expect(diskFillColor(1)).toBe('hsl(0, 70%, 45%)');
  });

  it('clamps out-of-range ratios', () => {
    expect(diskFillColor(-1)).toBe('hsl(140, 70%, 45%)');
    expect(diskFillColor(2)).toBe('hsl(0, 70%, 45%)');
  });
});
