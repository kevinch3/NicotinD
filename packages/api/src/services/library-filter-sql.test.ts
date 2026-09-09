import { describe, expect, it } from 'bun:test';
import { CAMELOT_WHEEL } from '@nicotind/core';
import { keyToCamelot } from './key-detection.js';
import { albumFilterWheres, artistFilterWheres, songFilterWheres } from './library-filter-sql.js';

describe('songFilterWheres', () => {
  it('returns an empty fragment for an empty filter', () => {
    expect(songFilterWheres({})).toEqual({ wheres: [], params: [] });
  });

  it('builds bpm / year / duration range conditions', () => {
    expect(songFilterWheres({ bpmMin: 120, bpmMax: 140 })).toEqual({
      wheres: ['s.bpm >= ?', 's.bpm <= ?'],
      params: [120, 140],
    });
    expect(songFilterWheres({ yearMin: 1990 })).toEqual({
      wheres: ['s.year >= ?'],
      params: [1990],
    });
    expect(songFilterWheres({ durationMin: 120, durationMax: 360 })).toEqual({
      wheres: ['s.duration >= ?', 's.duration <= ?'],
      params: [120, 360],
    });
  });

  it('expands Camelot codes to enharmonic key spellings', () => {
    expect(songFilterWheres({ keys: ['3B', '8A'] })).toEqual({
      wheres: ['s.key IN (?, ?, ?)'],
      params: ['C# major', 'Db major', 'A minor'],
    });
  });

  it('filters moods and genres with IN lists', () => {
    expect(songFilterWheres({ moods: ['happy', 'party'] })).toEqual({
      wheres: ['s.mood IN (?, ?)'],
      params: ['happy', 'party'],
    });
    // Genre matches the FULL set via the join table (a track filed under
    // "Electronic; House" matches a House filter), with the primary column as
    // a pre-first-rescan fallback.
    expect(songFilterWheres({ genres: ['Rock', 'Hip-Hop, Rap'] })).toEqual({
      wheres: [
        '(s.genre IN (?, ?) OR EXISTS (SELECT 1 FROM library_song_genres sg WHERE sg.song_id = s.id AND sg.genre IN (?, ?)))',
      ],
      params: ['Rock', 'Hip-Hop, Rap', 'Rock', 'Hip-Hop, Rap'],
    });
  });

  it('matches only the primary genre when primaryGenreOnly is set (issue #222)', () => {
    expect(songFilterWheres({ genres: ['Rock', 'Cumbia'], primaryGenreOnly: true })).toEqual({
      wheres: ['s.genre IN (?, ?)'],
      params: ['Rock', 'Cumbia'],
    });
  });

  it('countries filter emits the credited-artist EXISTS', () => {
    const f = songFilterWheres({ countries: ['AR', 'UY'] });
    expect(f.wheres).toHaveLength(1);
    expect(f.wheres[0]).toContain('library_artist_origins');
    expect(f.wheres[0]).toContain('library_song_artists');
    expect(f.wheres[0]).toContain('s.artist_id'); // primary-artist UNION, matching the radio pool
    expect(f.params).toEqual(['AR', 'UY']);
  });

  it("the 'unknown' bucket is a NOT EXISTS, OR-composed with positives", () => {
    const f = songFilterWheres({ countries: ['AR', 'unknown'] });
    expect(f.wheres).toHaveLength(1);
    expect(f.wheres[0]).toMatch(/EXISTS[\s\S]*OR NOT EXISTS/);
    expect(f.params).toEqual(['AR']);
    const onlyUnknown = songFilterWheres({ countries: ['unknown'] });
    expect(onlyUnknown.wheres[0]).toContain('NOT EXISTS');
    expect(onlyUnknown.params).toEqual([]);
  });

  it('maps perceptual buckets to threshold ranges, OR within an axis', () => {
    expect(songFilterWheres({ buckets: { energy: ['low'] } }).wheres).toEqual(['s.energy <= 0.35']);
    expect(songFilterWheres({ buckets: { energy: ['mid'] } }).wheres).toEqual([
      '(s.energy > 0.35 AND s.energy < 0.65)',
    ]);
    expect(songFilterWheres({ buckets: { energy: ['low', 'high'] } }).wheres).toEqual([
      '(s.energy <= 0.35 OR s.energy >= 0.65)',
    ]);
    // Axes AND (separate where entries)
    expect(songFilterWheres({ buckets: { energy: ['high'], valence: ['low'] } }).wheres).toEqual([
      's.energy >= 0.65',
      's.valence <= 0.35',
    ]);
  });

  it('collapses all three buckets to IS NOT NULL (still excludes un-analyzed tracks)', () => {
    expect(songFilterWheres({ buckets: { energy: ['low', 'mid', 'high'] } }).wheres).toEqual([
      's.energy IS NOT NULL',
    ]);
  });

  it('includes song-level starred and honors a custom alias', () => {
    expect(songFilterWheres({ starred: true, bpmMin: 100 }, 'ls')).toEqual({
      wheres: ['ls.starred IS NOT NULL', 'ls.bpm >= ?'],
      params: [100],
    });
  });
});

describe('albumFilterWheres', () => {
  it('returns an empty fragment for an empty filter', () => {
    expect(albumFilterWheres({})).toEqual({ wheres: [], params: [] });
  });

  it('keeps starred at the album level, song conditions in a membership test', () => {
    const frag = albumFilterWheres({ starred: true, bpmMin: 120, moods: ['happy'] });
    expect(frag.wheres).toHaveLength(2);
    expect(frag.wheres[0]).toBe('library_albums.starred IS NOT NULL');
    expect(frag.wheres[1]).toBe(
      'library_albums.id IN (SELECT ls.album_id FROM library_songs ls WHERE ls.hidden = 0 AND ls.bpm >= ? AND ls.mood IN (?))',
    );
    expect(frag.params).toEqual([120, 'happy']);
  });

  it('emits no membership test when only starred is set', () => {
    expect(albumFilterWheres({ starred: true })).toEqual({
      wheres: ['library_albums.starred IS NOT NULL'],
      params: [],
    });
  });

  it('routes countries through the any-track membership test on the ls alias', () => {
    const frag = albumFilterWheres({ countries: ['AR'] });
    expect(frag.wheres).toHaveLength(1);
    expect(frag.wheres[0]).toContain('FROM library_songs ls');
    expect(frag.wheres[0]).toContain('ls.artist_id');
    expect(frag.params).toEqual(['AR']);
  });

  // The song predicate reads only `ls`. A correlated EXISTS re-derives the
  // whole matching-song set per entity row, which measured 176s on prod
  // (#1055); membership evaluates it once. Guard the shape, not the clock.
  it('never correlates the song subquery back to the album row', () => {
    const frag = albumFilterWheres({ countries: ['AR'], genres: ['Rock'] });
    expect(frag.wheres[0]).not.toContain('EXISTS (SELECT 1 FROM library_songs ls');
    expect(frag.wheres[0]).not.toContain('library_albums.id AND');
  });
});

describe('artistFilterWheres', () => {
  it('matches songs via artist_id or the multi-artist join table', () => {
    const frag = artistFilterWheres({ starred: true, buckets: { energy: ['high'] } });
    expect(frag.wheres[0]).toBe('library_artists.starred IS NOT NULL');
    expect(frag.wheres[1]).toBe(
      'library_artists.id IN (' +
        'SELECT ls.artist_id FROM library_songs ls WHERE ls.hidden = 0 AND ls.energy >= 0.65' +
        ' UNION ' +
        'SELECT sa.artist_id FROM library_song_artists sa JOIN library_songs ls ON ls.id = sa.song_id ' +
        'WHERE ls.hidden = 0 AND ls.energy >= 0.65)',
    );
    expect(frag.params).toEqual([]);
  });

  // Two UNION branches inline the song wheres twice, so every param must be
  // pushed twice, in order. A placeholder/param mismatch throws at query time,
  // not at build time — which is exactly the kind of break tsc cannot catch.
  it('binds the song params once per UNION branch', () => {
    const frag = artistFilterWheres({ countries: ['CL', 'AR'], bpmMin: 120 });
    const placeholders = (frag.wheres[0]?.match(/\?/g) ?? []).length;
    expect(frag.params).toEqual([120, 'CL', 'AR', 120, 'CL', 'AR']);
    expect(frag.params).toHaveLength(placeholders);
  });

  it('never correlates the song subquery back to the artist row', () => {
    const frag = artistFilterWheres({ countries: ['CL'] });
    expect(frag.wheres[0]).not.toContain('EXISTS (SELECT 1 FROM library_songs ls');
    expect(frag.wheres[0]).not.toContain('= library_artists.id');
  });
});

describe('CAMELOT_WHEEL consistency with key-detection', () => {
  it('agrees with keyToCamelot for all 24 canonical keys', () => {
    for (const entry of CAMELOT_WHEEL) {
      expect(keyToCamelot(entry.key)).toBe(entry.code);
    }
  });
});
