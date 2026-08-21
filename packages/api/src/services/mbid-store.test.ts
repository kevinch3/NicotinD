import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';

import { applySchema } from '../db.js';
import { getMbid, libraryAlbumTitles, upsertMbid } from './mbid-store.js';

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
