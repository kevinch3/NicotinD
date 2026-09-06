import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { libraryRoutes } from './library.js';

// Isolated in-memory DB (see library.recent-songs.test.ts for the rationale).
let testDb: Database = (() => {
  const d = new Database(':memory:');
  applySchema(d);
  return d;
})();

mock.module('../db.js', () => ({
  getDatabase: () => testDb,
  initDatabase: () => testDb,
  applySchema,
}));

function seedSong(
  db: Database,
  s: {
    id: string;
    albumId: string;
    hidden?: number;
    landed?: number;
    albumHidden?: number;
  },
): void {
  db.run(
    `INSERT OR IGNORE INTO library_albums (id, name, artist, artist_id, song_count, duration, created, synced_at, hidden)
     VALUES (?, ?, 'Artist', 'artist', 1, 0, '2026-03-20T10:00:00.000Z', 0, ?)`,
    [s.albumId, s.albumId, s.albumHidden ?? 0],
  );
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, landed_at, synced_at, hidden)
     VALUES (?, ?, ?, 'Artist', 'artist', 0, ?, 0, 0, 'mp3', 'audio/mpeg', '2026-03-20T10:00:00.000Z', ?, 0, ?)`,
    [
      s.id,
      s.albumId,
      s.id,
      `Artist/${s.albumId}/${s.id}.mp3`,
      s.landed === 0 ? null : 1,
      s.hidden ?? 0,
    ],
  );
}

// The route reads `a.hidden` from SONG_SELECT's own join rather than joining
// library_albums a second time (#822). These pin the semantics that swap had to
// preserve: drop the predicate with the join and hidden albums leak.
describe('library /random', () => {
  let app: Hono;

  beforeEach(() => {
    testDb = new Database(':memory:');
    applySchema(testDb);
    seedSong(testDb, { id: 'song-visible', albumId: 'album-visible' });
    app = new Hono();
    app.route('/', libraryRoutes('/music'));
  });

  afterEach(() => {
    testDb.close();
  });

  const ids = async (url: string): Promise<string[]> => {
    const res = await app.request(url);
    expect(res.status).toBe(200);
    return ((await res.json()) as Array<{ id: string }>).map((s) => s.id);
  };

  it('excludes songs whose album is hidden', async () => {
    seedSong(testDb, { id: 'song-album-hidden', albumId: 'album-hidden', albumHidden: 1 });
    const got = await ids('/random?size=200');
    expect(got).not.toContain('song-album-hidden');
    expect(got).toContain('song-visible');
  });

  it('keeps a song whose album row is missing, so the join yields NULL', async () => {
    seedSong(testDb, { id: 'song-orphan', albumId: 'album-gone' });
    testDb.run(`DELETE FROM library_albums WHERE id = 'album-gone'`);
    expect(await ids('/random?size=200')).toContain('song-orphan');
  });

  it('excludes hidden songs', async () => {
    seedSong(testDb, { id: 'song-hidden', albumId: 'album-visible', hidden: 1 });
    expect(await ids('/random?size=200')).not.toContain('song-hidden');
  });

  it('excludes quarantined songs that have not landed', async () => {
    seedSong(testDb, { id: 'song-quarantined', albumId: 'album-visible', landed: 0 });
    expect(await ids('/random?size=200')).not.toContain('song-quarantined');
  });

  it('returns each song at most once', async () => {
    for (let n = 0; n < 20; n++) seedSong(testDb, { id: `song-${n}`, albumId: 'album-visible' });
    const got = await ids('/random?size=200');
    expect(got.length).toBe(new Set(got).size);
    expect(got.length).toBe(21);
  });

  it('caps size at 200', async () => {
    for (let n = 0; n < 220; n++) seedSong(testDb, { id: `song-${n}`, albumId: 'album-visible' });
    expect((await ids('/random?size=500')).length).toBe(200);
  });

  it('defaults to 10 songs', async () => {
    for (let n = 0; n < 20; n++) seedSong(testDb, { id: `song-${n}`, albumId: 'album-visible' });
    expect((await ids('/random')).length).toBe(10);
  });
});
