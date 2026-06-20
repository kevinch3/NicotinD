import { describe, it, expect } from 'vitest';
import { spotifyMetaParts, spotifySubtitle } from './spotify-display';

describe('spotify-display', () => {
  it('joins artist, year, track count and kind', () => {
    expect(
      spotifySubtitle({ artist: 'Shaggy', year: '2000', trackCount: 14, kind: 'album' }),
    ).toBe('Shaggy · 2000 · 14 tracks · album');
  });

  it('uses the singular "track" for a single', () => {
    expect(spotifySubtitle({ artist: 'Shaggy', year: null, trackCount: 1, kind: 'single' })).toBe(
      'Shaggy · 1 track · single',
    );
  });

  it('omits unknown pieces (no literal Unknown)', () => {
    expect(spotifyMetaParts({ artist: '', year: null, trackCount: null, kind: null })).toEqual([]);
    expect(spotifySubtitle({ artist: '', year: null, trackCount: null, kind: null })).toBe('');
  });

  it('drops a zero/unknown track count but keeps artist', () => {
    expect(spotifySubtitle({ artist: 'Bacilos', year: '2002', trackCount: 0, kind: null })).toBe(
      'Bacilos · 2002',
    );
  });
});
