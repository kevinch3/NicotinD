import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';

import { applySchema } from '../db.js';
import {
  MBID_AMBIGUITY_FIX_AT,
  getMbid,
  isMbidReResolvable,
  libraryAlbumTitles,
  upsertMbid,
  type MbidRow,
} from './mbid-store.js';

const freshDb = (): Database => {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
};

describe('mbid-store', () => {
  it('round-trips an id', () => {
    const db = freshDb();
    upsertMbid(db, {
      scope: 'artist',
      key: 'jose larralde',
      mbid: 'bd60',
      source: 'tag',
      confidence: 1,
    });
    expect(getMbid(db, 'artist', 'jose larralde')?.mbid).toBe('bd60');
  });

  it('never lets a fuzzy search downgrade a tag-read id', () => {
    const db = freshDb();
    upsertMbid(db, { scope: 'artist', key: 'k', mbid: 'from-tag', source: 'tag', confidence: 1 });
    expect(
      upsertMbid(db, {
        scope: 'artist',
        key: 'k',
        mbid: 'from-search',
        source: 'mb-search',
        confidence: 0.3,
      }),
    ).toBe(false);
    expect(getMbid(db, 'artist', 'k')?.mbid).toBe('from-tag');
  });

  it('lets a user decision override anything', () => {
    const db = freshDb();
    upsertMbid(db, { scope: 'artist', key: 'k', mbid: 'from-tag', source: 'tag', confidence: 1 });
    expect(
      upsertMbid(db, {
        scope: 'artist',
        key: 'k',
        mbid: 'corrected',
        source: 'user',
        confidence: 1,
      }),
    ).toBe(true);
    expect(getMbid(db, 'artist', 'k')?.mbid).toBe('corrected');
  });

  it('returns null for an unknown key', () => {
    expect(getMbid(freshDb(), 'album', 'nope')).toBeNull();
  });
});

describe('libraryAlbumTitles (issue #610)', () => {
  it('returns the artist own album titles, for MBID corroboration', () => {
    const db = freshDb();
    const artist = (id: string, name: string) =>
      db.run(`INSERT INTO library_artists (id, name, album_count, synced_at) VALUES (?, ?, 0, 0)`, [
        id,
        name,
      ]);
    const album = (id: string, name: string, artistId: string) =>
      db.run(
        `INSERT INTO library_albums (id, name, artist, artist_id, synced_at)
         VALUES (?, ?, 'x', ?, 0)`,
        [id, name, artistId],
      );
    artist('a1', 'Emilia');
    artist('a2', 'Other');
    album('b1', 'perfectas', 'a1');
    album('b2', '.mp3', 'a1');
    album('b3', 'Alla mot alla', 'a2');

    expect(libraryAlbumTitles(db, 'a1').sort()).toEqual(['.mp3', 'perfectas']);
  });

  it('returns an empty list for an artist with no albums', () => {
    const db = freshDb();
    expect(libraryAlbumTitles(db, 'nobody')).toEqual([]);
  });
});

/**
 * Issue #1008: a row written before #611 stopped `pickMbidHit` taking the
 * first of N same-name hits can be a coin flip, so it is the one population
 * worth resolving again.
 */
describe('isMbidReResolvable (issue #1008)', () => {
  const row = (over: Partial<MbidRow> = {}): MbidRow => ({
    scope: 'artist',
    key: 'gondwana',
    mbid: '26962985-3e12-4f0b-a87e-68306e08b0b5',
    source: 'lidarr',
    confidence: 0.8,
    checkedAt: MBID_AMBIGUITY_FIX_AT - 1,
    ...over,
  });

  it('re-resolves an automatic row checked before the ambiguity fix', () => {
    expect(isMbidReResolvable(row())).toBe(true);
    expect(isMbidReResolvable(row({ source: 'mb-search', confidence: 0.3 }))).toBe(true);
  });

  it('leaves a row checked after the fix alone', () => {
    expect(isMbidReResolvable(row({ checkedAt: MBID_AMBIGUITY_FIX_AT }))).toBe(false);
    expect(isMbidReResolvable(row({ checkedAt: Date.now() }))).toBe(false);
  });

  it('never re-resolves a user row, however old', () => {
    expect(isMbidReResolvable(row({ source: 'user', checkedAt: 0 }))).toBe(false);
  });

  it('never re-resolves a tag-read row (nothing automatic could overwrite it)', () => {
    expect(isMbidReResolvable(row({ source: 'tag', checkedAt: 0 }))).toBe(false);
  });

  it('is false for a missing row (that path is a plain cache miss)', () => {
    expect(isMbidReResolvable(null)).toBe(false);
  });

  it('re-resolution refreshes checked_at, so a row leaves the stale set', () => {
    const db = freshDb();
    upsertMbid(db, {
      scope: 'artist',
      key: 'gondwana',
      mbid: 'au-id',
      source: 'lidarr',
      confidence: 0.8,
    });
    db.run(`UPDATE library_mbids SET checked_at = ? WHERE key = 'gondwana'`, [
      MBID_AMBIGUITY_FIX_AT - 1,
    ]);
    expect(isMbidReResolvable(getMbid(db, 'artist', 'gondwana'))).toBe(true);
    upsertMbid(db, {
      scope: 'artist',
      key: 'gondwana',
      mbid: 'cl-id',
      source: 'lidarr',
      confidence: 0.7,
    });
    expect(isMbidReResolvable(getMbid(db, 'artist', 'gondwana'))).toBe(false);
  });
});
