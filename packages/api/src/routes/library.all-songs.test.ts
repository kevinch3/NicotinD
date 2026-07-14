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

function createTestDb(): Database {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

function seedSong(
  db: Database,
  s: {
    id: string;
    title: string;
    artist: string;
    album: string;
    albumId: string;
    path: string;
    created: string;
    bpm?: number;
    genre?: string;
    hidden?: number;
    landed?: number;
    albumHidden?: number;
  },
): void {
  db.run(
    `INSERT OR IGNORE INTO library_albums (id, name, artist, artist_id, song_count, duration, created, synced_at, hidden)
     VALUES (?, ?, ?, ?, 1, 0, ?, 0, ?)`,
    [s.albumId, s.album, s.artist, s.artist, s.created, s.albumHidden ?? 0],
  );
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, landed_at, synced_at, hidden, bpm, genre)
     VALUES (?, ?, ?, ?, ?, 0, ?, 0, 0, 'mp3', 'audio/mpeg', ?, ?, 0, ?, ?, ?)`,
    [
      s.id,
      s.albumId,
      s.title,
      s.artist,
      s.artist,
      s.path,
      s.created,
      s.landed === 0 ? null : (s.landed ?? 1),
      s.hidden ?? 0,
      s.bpm ?? null,
      s.genre ?? null,
    ],
  );
  if (s.genre) {
    db.run(
      `INSERT INTO library_song_genres (song_id, genre, position) VALUES (?, ?, 0)`,
      [s.id, s.genre],
    );
  }
}

describe('library /songs (whole-library listing)', () => {
  let app: Hono;

  beforeEach(() => {
    testDb = createTestDb();
    seedSong(testDb, {
      id: 'song-1',
      title: 'Alpha',
      artist: 'Artist A',
      album: 'One',
      albumId: 'album-1',
      path: 'Artist A/One/01 - Alpha.mp3',
      created: '2026-03-20T10:00:00.000Z',
      bpm: 128,
      genre: 'House',
    });
    seedSong(testDb, {
      id: 'song-2',
      title: 'Bravo',
      artist: 'Artist B',
      album: 'Two',
      albumId: 'album-2',
      path: 'Artist B/Two/01 - Bravo.mp3',
      created: '2026-03-20T09:00:00.000Z',
      bpm: 90,
      genre: 'Jazz',
    });
    seedSong(testDb, {
      id: 'song-3',
      title: 'Charlie',
      artist: 'Artist C',
      album: 'Three',
      albumId: 'album-3',
      path: 'Artist C/Three/01 - Charlie.mp3',
      created: '2026-03-20T08:00:00.000Z',
      bpm: 130,
      genre: 'House',
    });

    app = new Hono();
    app.route('/', libraryRoutes('/music'));
  });

  afterEach(() => {
    testDb.close();
  });

  it('defaults to newest-first ordering', async () => {
    const res = await app.request('/songs');
    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<{ id: string }>;
    expect(data.map((s) => s.id)).toEqual(['song-1', 'song-2', 'song-3']);
  });

  it('sorts by title', async () => {
    const res = await app.request('/songs?sort=title');
    const data = (await res.json()) as Array<{ id: string }>;
    expect(data.map((s) => s.id)).toEqual(['song-1', 'song-2', 'song-3']);
  });

  it('narrows by a LibraryFilter (genre)', async () => {
    const res = await app.request('/songs?genre=House');
    const data = (await res.json()) as Array<{ id: string }>;
    expect(data.map((s) => s.id).sort()).toEqual(['song-1', 'song-3']);
  });

  it('narrows by a LibraryFilter (bpm range)', async () => {
    const res = await app.request('/songs?bpmMin=120&bpmMax=135');
    const data = (await res.json()) as Array<{ id: string }>;
    expect(data.map((s) => s.id).sort()).toEqual(['song-1', 'song-3']);
  });

  it('paginates with size + offset', async () => {
    const first = await app.request('/songs?size=2&offset=0');
    expect((await first.json()).map((s: { id: string }) => s.id)).toEqual(['song-1', 'song-2']);
    const second = await app.request('/songs?size=2&offset=2');
    expect((await second.json()).map((s: { id: string }) => s.id)).toEqual(['song-3']);
  });

  it('excludes hidden, quarantined, and album-hidden songs', async () => {
    seedSong(testDb, {
      id: 'song-hidden',
      title: 'Hidden',
      artist: 'X',
      album: 'HX',
      albumId: 'album-hx',
      path: 'X/HX/01.mp3',
      created: '2026-03-21T00:00:00.000Z',
      hidden: 1,
    });
    seedSong(testDb, {
      id: 'song-quarantined',
      title: 'Quarantined',
      artist: 'Y',
      album: 'QY',
      albumId: 'album-qy',
      path: 'Y/QY/01.mp3',
      created: '2026-03-21T00:00:00.000Z',
      landed: 0,
    });
    seedSong(testDb, {
      id: 'song-album-hidden',
      title: 'AlbumHidden',
      artist: 'Z',
      album: 'ZH',
      albumId: 'album-zh',
      path: 'Z/ZH/01.mp3',
      created: '2026-03-21T00:00:00.000Z',
      albumHidden: 1,
    });

    const res = await app.request('/songs?size=200');
    const data = (await res.json()) as Array<{ id: string }>;
    const ids = data.map((s) => s.id);
    expect(ids).not.toContain('song-hidden');
    expect(ids).not.toContain('song-quarantined');
    expect(ids).not.toContain('song-album-hidden');
    expect(ids).toContain('song-1');
  });
});
