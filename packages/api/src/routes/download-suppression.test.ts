import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { albumIdsByGroupKey, __resetDownloadSuppressionCache } from './library.js';

function insertAlbum(db: Database, id: string, artist: string, name: string): void {
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, synced_at) VALUES (?, ?, ?, ?, 1)`,
    [id, name, artist, id + '-artist'],
  );
}

describe('albumIdsByGroupKey (download-suppression cache)', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    __resetDownloadSuppressionCache();
  });

  it('maps normalized "artist album" group keys to album ids', () => {
    insertAlbum(db, 'a1', 'Daft Punk', 'Discovery');
    const map = albumIdsByGroupKey(db);
    expect(map.get('daft punk discovery')).toEqual(['a1']);
  });

  it('memoizes the album scan — new rows are not seen until the cache is reset', () => {
    insertAlbum(db, 'a1', 'A', 'One');
    expect(albumIdsByGroupKey(db).has('a one')).toBe(true);

    // Insert a second album; the cached map must not reflect it yet.
    insertAlbum(db, 'a2', 'B', 'Two');
    expect(albumIdsByGroupKey(db).has('b two')).toBe(false);

    // After an explicit reset the next call re-scans and sees both.
    __resetDownloadSuppressionCache();
    const fresh = albumIdsByGroupKey(db);
    expect(fresh.has('a one')).toBe(true);
    expect(fresh.has('b two')).toBe(true);
  });
});
