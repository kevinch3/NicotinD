import { describe, it, expect } from 'bun:test';
import { modeYear, pickAlbumYear, mbCacheKey, mbCacheYear } from './year-backfill.js';

describe('modeYear', () => {
  it('returns the most frequent plausible year', () => {
    expect(modeYear([1992, 1992, 1993])).toBe(1992);
  });
  it('breaks ties toward the earliest year (original release)', () => {
    expect(modeYear([2005, 2005, 1980, 1980])).toBe(1980);
  });
  it('ignores implausible years and empty input', () => {
    expect(modeYear([0, 1, 3000, 1850])).toBeNull();
    expect(modeYear([])).toBeNull();
  });
});

describe('pickAlbumYear', () => {
  it('prefers the tag year over folder and mb-cache', () => {
    expect(pickAlbumYear({ tagYears: [1992], folderYear: 2001, mbYears: [1983] })).toEqual({
      year: 1992,
      source: 'tag',
    });
  });
  it('falls back to the folder year (comps)', () => {
    expect(pickAlbumYear({ tagYears: [], folderYear: 2015, mbYears: [1999] })).toEqual({
      year: 2015,
      source: 'folder',
    });
  });
  it('falls back to the mb-cache year last', () => {
    expect(pickAlbumYear({ tagYears: [], folderYear: null, mbYears: [1983, 1983, 1990] })).toEqual({
      year: 1983,
      source: 'mb-cache',
    });
  });
  it('returns null when no signal is available', () => {
    expect(pickAlbumYear({ tagYears: [], folderYear: null, mbYears: [] })).toBeNull();
  });
});

describe('mb-cache helpers', () => {
  it('builds the diacritic-folded recording key', () => {
    expect(mbCacheKey('Astor Piazzolla', 'María de Buenos Aires')).toBe(
      'recording:astor piazzolla|maria de buenos aires',
    );
  });
  it('extracts a plausible year from a cache entry, else null', () => {
    expect(mbCacheYear({ result: { release: { date: '1983-05-01' } } })).toBe(1983);
    expect(mbCacheYear({ result: { release: {} } })).toBeNull();
    expect(mbCacheYear(undefined)).toBeNull();
  });
});
