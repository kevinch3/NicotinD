import { describe, it, expect } from 'vitest';
import { archiveMetaParts, archiveSubtitle } from './archive-display';

describe('archive-display', () => {
  it('joins creator, year, track count and kind', () => {
    expect(
      archiveSubtitle({ creator: 'Shaggy', year: '2000', trackCount: 14, kind: 'album' }),
    ).toBe('Shaggy · 2000 · 14 tracks · album');
  });

  it('uses the singular "track" for a single', () => {
    expect(archiveSubtitle({ creator: 'Shaggy', year: null, trackCount: 1, kind: 'single' })).toBe(
      'Shaggy · 1 track · single',
    );
  });

  it('omits unknown pieces (no literal Unknown)', () => {
    expect(archiveMetaParts({ creator: '', year: null, trackCount: null, kind: null })).toEqual([]);
    expect(archiveSubtitle({ creator: '', year: null, trackCount: null, kind: null })).toBe('');
  });

  it('drops a zero/unknown track count but keeps creator', () => {
    expect(archiveSubtitle({ creator: 'Bacilos', year: '2002', trackCount: 0, kind: null })).toBe(
      'Bacilos · 2002',
    );
  });
});
