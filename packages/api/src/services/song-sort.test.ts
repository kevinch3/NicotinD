import { describe, expect, it } from 'bun:test';
import { songOrderBy } from './song-sort.js';

describe('songOrderBy', () => {
  it('orders by title (case-insensitive) for sort=title', () => {
    expect(songOrderBy('title')).toBe('s.title COLLATE NOCASE ASC');
  });

  it('groups by album then disc/track for sort=album', () => {
    expect(songOrderBy('album')).toContain('a.name COLLATE NOCASE ASC');
    expect(songOrderBy('album')).toContain('s.track ASC NULLS LAST');
  });

  it('defaults to newest-first for unknown / missing sort (no raw input leaks)', () => {
    const newest = 's.created DESC, s.title COLLATE NOCASE ASC';
    expect(songOrderBy('newest')).toBe(newest);
    expect(songOrderBy('')).toBe(newest);
    expect(songOrderBy('; DROP TABLE library_songs')).toBe(newest);
  });
});
