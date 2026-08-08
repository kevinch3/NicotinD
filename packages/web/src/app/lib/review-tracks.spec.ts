import { describe, it, expect } from 'vitest';
import {
  toEditableTracks,
  dirtyTrackPayload,
  applyIdentify,
  markTracksSaved,
  applyCanonicalTracklist,
} from './review-tracks';

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

describe('markTracksSaved', () => {
  it('clears dirty flags on every row when nothing failed', () => {
    const rows = toEditableTracks([
      { id: 'a', title: 'A', track: 1 },
      { id: 'b', title: 'B', track: 2 },
    ]).map((t) => ({ ...t, dirtyTitle: true }));
    const next = markTracksSaved(rows, []);
    expect(next.every((t) => !t.dirtyTitle && !t.dirtyArtist)).toBe(true);
  });

  it('keeps a failed row dirty (and its edits) while clearing the rest', () => {
    const rows = toEditableTracks([
      { id: 'a', title: 'A', track: 1 },
      { id: 'b', title: 'B', track: 2 },
    ]).map((t) => ({ ...t, title: t.id === 'a' ? 'A2' : 'B2', dirtyTitle: true }));

    const next = markTracksSaved(rows, ['a']);

    const a = next.find((t) => t.id === 'a')!;
    const b = next.find((t) => t.id === 'b')!;
    expect(a).toEqual({ ...a, title: 'A2', dirtyTitle: true });
    expect(b.dirtyTitle).toBe(false);
    expect(b.title).toBe('B2');
  });

  // Issue #413: MusicBrainz is the one candidate source with a per-track
  // tracklist; applying it is position-matched because a curator reaches for
  // this precisely when the existing titles are junk.
  describe('applyCanonicalTracklist', () => {
    it('overwrites titles by track number and marks them dirty', () => {
      const rows = toEditableTracks([
        { id: 'a', title: 'track01', track: 1 },
        { id: 'b', title: 'track02', track: 2 },
      ]);

      const next = applyCanonicalTracklist(rows, [
        { position: 1, title: 'Real One' },
        { position: 2, title: 'Real Two' },
      ]);

      expect(next.map((t) => [t.title, t.dirtyTitle])).toEqual([
        ['Real One', true],
        ['Real Two', true],
      ]);
    });

    it('falls back to grid order for rows with no track number', () => {
      const rows = toEditableTracks([
        { id: 'a', title: 'x', track: null },
        { id: 'b', title: 'y', track: null },
      ]);

      const next = applyCanonicalTracklist(rows, [
        { position: 1, title: 'First' },
        { position: 2, title: 'Second' },
      ]);

      expect(next.map((t) => t.title)).toEqual(['First', 'Second']);
    });

    it('leaves a row with no canonical counterpart untouched, never blanked', () => {
      const rows = toEditableTracks([
        { id: 'a', title: 'Keep Me', track: 1 },
        { id: 'b', title: 'Bonus Track', track: 2 },
      ]);

      const next = applyCanonicalTracklist(rows, [{ position: 1, title: 'Keep Me' }]);

      // Position 1 already matches, so it isn't even marked dirty.
      expect(next[0]).toEqual({ ...rows[0]! });
      expect(next[1]).toEqual({ ...rows[1]! });
    });

    it('never touches the artist field (MB credits are recording-level)', () => {
      const rows = toEditableTracks([{ id: 'a', title: 'x', track: 1, artist: 'Kept' }]);

      const next = applyCanonicalTracklist(rows, [{ position: 1, title: 'New' }]);

      expect(next[0]!.artist).toBe('Kept');
      expect(next[0]!.dirtyArtist).toBe(false);
    });

    it('ignores blank canonical titles', () => {
      const rows = toEditableTracks([{ id: 'a', title: 'Original', track: 1 }]);
      const next = applyCanonicalTracklist(rows, [{ position: 1, title: '   ' }]);
      expect(next[0]!.title).toBe('Original');
      expect(next[0]!.dirtyTitle).toBe(false);
    });
  });
});
