import { describe, expect, it } from 'bun:test';
import { CAMELOT_WHEEL } from '@nicotind/core';
import { keyToCamelot } from './key-detection.js';
import {
  albumFilterWheres,
  artistFilterWheres,
  songFilterWheres,
} from './library-filter-sql.js';

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

  it('maps perceptual buckets to threshold ranges, OR within an axis', () => {
    expect(songFilterWheres({ buckets: { energy: ['low'] } }).wheres).toEqual([
      's.energy <= 0.35',
    ]);
    expect(songFilterWheres({ buckets: { energy: ['mid'] } }).wheres).toEqual([
      '(s.energy > 0.35 AND s.energy < 0.65)',
    ]);
    expect(songFilterWheres({ buckets: { energy: ['low', 'high'] } }).wheres).toEqual([
      '(s.energy <= 0.35 OR s.energy >= 0.65)',
    ]);
    // Axes AND (separate where entries)
    expect(
      songFilterWheres({ buckets: { energy: ['high'], valence: ['low'] } }).wheres,
    ).toEqual(['s.energy >= 0.65', 's.valence <= 0.35']);
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

  it('keeps starred at the album level, song conditions in an EXISTS', () => {
    const frag = albumFilterWheres({ starred: true, bpmMin: 120, moods: ['happy'] });
    expect(frag.wheres).toHaveLength(2);
    expect(frag.wheres[0]).toBe('library_albums.starred IS NOT NULL');
    expect(frag.wheres[1]).toBe(
      'EXISTS (SELECT 1 FROM library_songs ls WHERE ls.album_id = library_albums.id AND ls.hidden = 0 AND ls.bpm >= ? AND ls.mood IN (?))',
    );
    expect(frag.params).toEqual([120, 'happy']);
  });

  it('emits no EXISTS when only starred is set', () => {
    expect(albumFilterWheres({ starred: true })).toEqual({
      wheres: ['library_albums.starred IS NOT NULL'],
      params: [],
    });
  });
});

describe('artistFilterWheres', () => {
  it('matches songs via artist_id or the multi-artist join table', () => {
    const frag = artistFilterWheres({ starred: true, buckets: { energy: ['high'] } });
    expect(frag.wheres[0]).toBe('library_artists.starred IS NOT NULL');
    expect(frag.wheres[1]).toBe(
      'EXISTS (SELECT 1 FROM library_songs ls WHERE (ls.artist_id = library_artists.id OR ls.id IN ' +
        '(SELECT song_id FROM library_song_artists WHERE artist_id = library_artists.id)) ' +
        'AND ls.hidden = 0 AND ls.energy >= 0.65)',
    );
    expect(frag.params).toEqual([]);
  });
});

describe('CAMELOT_WHEEL consistency with key-detection', () => {
  it('agrees with keyToCamelot for all 24 canonical keys', () => {
    for (const entry of CAMELOT_WHEEL) {
      expect(keyToCamelot(entry.key)).toBe(entry.code);
    }
  });
});
