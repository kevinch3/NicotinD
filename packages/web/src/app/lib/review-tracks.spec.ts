import { describe, it, expect } from 'vitest';
import { toEditableTracks, dirtyTrackPayload, applyIdentify } from './review-tracks';

describe('toEditableTracks', () => {
  it('orders by track number, nulls last', () => {
    const rows = toEditableTracks([
      { id: 'c', title: 'C', track: null },
      { id: 'a', title: 'A', track: 2 },
      { id: 'b', title: 'B', track: 1 },
    ]);
    expect(rows.map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });

  it('starts every row clean with artist defaulted to empty string', () => {
    const rows = toEditableTracks([{ id: 'a', title: 'A', track: 1 }]);
    expect(rows).toEqual([
      { id: 'a', track: 1, title: 'A', artist: '', dirtyTitle: false, dirtyArtist: false },
    ]);
  });

  it('preserves a supplied artist', () => {
    const rows = toEditableTracks([{ id: 'a', title: 'A', track: 1, artist: 'Band' }]);
    expect(rows[0]?.artist).toBe('Band');
  });
});

describe('dirtyTrackPayload', () => {
  const base = toEditableTracks([{ id: 'a', title: 'A', track: 1, artist: 'X' }]);

  it('returns nothing when no row is dirty', () => {
    expect(dirtyTrackPayload(base)).toEqual([]);
  });

  it('carries only the edited field when just the title changed', () => {
    const edited = base.map((t) => ({ ...t, title: 'New Title', dirtyTitle: true }));
    expect(dirtyTrackPayload(edited)).toEqual([{ id: 'a', title: 'New Title' }]);
  });

  it('carries only artist when just the artist changed', () => {
    const edited = base.map((t) => ({ ...t, artist: 'New Artist', dirtyArtist: true }));
    expect(dirtyTrackPayload(edited)).toEqual([{ id: 'a', artist: 'New Artist' }]);
  });

  it('carries both fields when both changed', () => {
    const edited = base.map((t) => ({
      ...t,
      title: 'T2',
      artist: 'A2',
      dirtyTitle: true,
      dirtyArtist: true,
    }));
    expect(dirtyTrackPayload(edited)).toEqual([{ id: 'a', title: 'T2', artist: 'A2' }]);
  });

  it('omits clean rows from a mixed set', () => {
    const rows = toEditableTracks([
      { id: 'a', title: 'A', track: 1 },
      { id: 'b', title: 'B', track: 2 },
    ]);
    const edited = rows.map((t) => (t.id === 'b' ? { ...t, title: 'B2', dirtyTitle: true } : t));
    expect(dirtyTrackPayload(edited)).toEqual([{ id: 'b', title: 'B2' }]);
  });
});

describe('applyIdentify', () => {
  const row = toEditableTracks([
    { id: 'a', title: 'Old Title', track: 1, artist: 'Old Artist' },
  ])[0]!;

  it('is a no-op on an empty result', () => {
    const next = applyIdentify(row, {});
    expect(next).toEqual(row);
  });

  it('sets title + dirtyTitle when a title comes back', () => {
    const next = applyIdentify(row, { title: 'New Title' });
    expect(next.title).toBe('New Title');
    expect(next.dirtyTitle).toBe(true);
    expect(next.artist).toBe('Old Artist');
    expect(next.dirtyArtist).toBe(false);
  });

  it('sets artist + dirtyArtist when an artist comes back', () => {
    const next = applyIdentify(row, { artist: 'New Artist' });
    expect(next.artist).toBe('New Artist');
    expect(next.dirtyArtist).toBe(true);
    expect(next.title).toBe('Old Title');
  });

  it('ignores a blank/whitespace-only field', () => {
    const next = applyIdentify(row, { title: '   ', artist: '' });
    expect(next).toEqual(row);
  });

  it('sets both fields when both come back', () => {
    const next = applyIdentify(row, { title: 'T', artist: 'A' });
    expect(next.title).toBe('T');
    expect(next.artist).toBe('A');
    expect(next.dirtyTitle).toBe(true);
    expect(next.dirtyArtist).toBe(true);
  });
});
