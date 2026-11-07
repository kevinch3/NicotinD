import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { bumpCoverRev } from './cover-rev.js';
import { noArtCache } from './cover-negative-cache.js';
import { libraryEvents, type StampedEvent } from './library-events.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
     VALUES ('al1', 'Al', 'A', 'ar1', 1, 0, 0)`,
  );
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, synced_at)
     VALUES ('s1', 'al1', 'T', 'A', 'ar1', 0, 'a/b.mp3', 0)`,
  );
  db.run(
    `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES ('ar1', 'A', 1, 0)`,
  );
  noArtCache.clear();
  libraryEvents.flush();
});

function during(fn: () => void): StampedEvent[] {
  const seen: StampedEvent[] = [];
  const off = libraryEvents.on((e) => seen.push(e));
  try {
    fn();
    libraryEvents.flush();
  } finally {
    off();
  }
  return seen;
}

describe('bumpCoverRev (#1666)', () => {
  it('persists a monotonic rev per entity and announces it', () => {
    const seen = during(() => {
      expect(bumpCoverRev(db, 'album', 'al1')).toBe(1);
      expect(bumpCoverRev(db, 'album', 'al1')).toBe(2);
      expect(bumpCoverRev(db, 'artist', 'ar1')).toBe(1);
    });
    expect(seen.map((e) => e.event)).toEqual([
      {
        type: 'artwork.changed',
        changes: [
          { kind: 'album', id: 'al1', rev: 2 },
          { kind: 'artist', id: 'ar1', rev: 1 },
        ],
      },
    ]);
  });

  it('evicts the negative cache for an album and every song that resolves to its cover', () => {
    const later = Date.now() + 60_000;
    for (const id of ['al1', 's1', 'ar1', 'other']) noArtCache.set(id, later);
    bumpCoverRev(db, 'album', 'al1');
    expect([...noArtCache.keys()].sort()).toEqual(['ar1', 'other']);
    bumpCoverRev(db, 'artist', 'ar1');
    expect([...noArtCache.keys()]).toEqual(['other']);
  });

  it('a deleted and re-landed entity never re-issues a rev its previous incarnation used', () => {
    // Ids are name-derived, so a re-acquired album comes back at the same id with
    // cover_rev 0. Restarting the count would rebuild `&v=1` — a URL the browser
    // cached with the previous incarnation's bytes.
    expect(bumpCoverRev(db, 'album', 'al1')).toBe(1);
    expect(bumpCoverRev(db, 'album', 'al1')).toBe(2);
    db.run(`DELETE FROM library_albums WHERE id = 'al1'`);
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
       VALUES ('al1', 'Al', 'A', 'ar1', 1, 0, 0)`,
    );
    expect(bumpCoverRev(db, 'album', 'al1')).toBe(3);
    // Per kind: an artist sharing the id string has its own count.
    expect(bumpCoverRev(db, 'artist', 'ar1')).toBe(1);
  });

  it('an id with no row yet returns null and announces nothing, but still evicts', () => {
    noArtCache.set('ghost', Date.now() + 60_000);
    const seen = during(() => expect(bumpCoverRev(db, 'album', 'ghost')).toBeNull());
    expect(seen).toEqual([]);
    expect(noArtCache.has('ghost')).toBe(false);
    expect(db.query(`SELECT 1 FROM library_cover_rev_floor`).all()).toEqual([]);
  });
});
