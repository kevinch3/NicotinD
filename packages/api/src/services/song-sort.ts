/**
 * SQL ORDER BY fragment for the artist Songs tab. A whitelist (never the raw
 * query string) so the value is safe to interpolate into the statement. Columns
 * are aliased to match SONG_SELECT (`s` = library_songs, `a` = library_albums).
 * Every order ends on `s.id`, so a paged walk (OpenSubsonic `search3`) never
 * sees a row twice or skips one across a tie.
 */
export type SongSort = 'newest' | 'title' | 'album';

export function songOrderBy(sort: string): string {
  switch (sort) {
    case 'title':
      return 's.title COLLATE NOCASE ASC, s.id';
    case 'album':
      // Group by album, then disc/track order within it.
      return 'a.name COLLATE NOCASE ASC, s.disc ASC NULLS LAST, s.track ASC NULLS LAST, s.title COLLATE NOCASE ASC, s.id';
    case 'newest':
    default:
      return 's.created DESC, s.title COLLATE NOCASE ASC, s.id';
  }
}
