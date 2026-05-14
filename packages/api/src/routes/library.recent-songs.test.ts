import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { libraryRoutes } from './library.js';

// Use an isolated in-memory DB so this test file is not affected by other
// test files that mock or replace the db.js singleton. Initialized at module
// load so the mock can be called before any beforeEach runs (Bun's mock.module
// is process-global; the last call for a module path wins).
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
  s: { id: string; title: string; artist: string; album: string; albumId: string; path: string; created: string },
): void {
  db.run(
    `INSERT OR IGNORE INTO library_albums (id, name, artist, artist_id, song_count, duration, created, synced_at)
     VALUES (?, ?, ?, ?, 1, 0, ?, 0)`,
    [s.albumId, s.album, s.artist, s.artist, s.created],
  );
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, synced_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, 0, 0, 'mp3', 'audio/mpeg', ?, 0)`,
    [s.id, s.albumId, s.title, s.artist, s.artist, s.path, s.created],
  );
}

describe('library recent-songs ordering', () => {
  let app: Hono;

  beforeEach(() => {
    testDb = createTestDb();
    seedSong(testDb, { id: 'song-1', title: 'First', artist: 'Artist A', album: 'Alpha', albumId: 'album-1', path: 'Artist A/Alpha/01 - First.mp3', created: '2026-03-20T10:00:00.000Z' });
    seedSong(testDb, { id: 'song-2', title: 'Second', artist: 'Artist A', album: 'Alpha', albumId: 'album-1', path: 'Artist A/Alpha/02 - Second.mp3', created: '2026-03-20T09:00:00.000Z' });
    seedSong(testDb, { id: 'song-3', title: 'Third', artist: 'Artist B', album: 'Beta', albumId: 'album-2', path: 'Artist B/Beta/01 - Third.mp3', created: '2026-03-20T08:00:00.000Z' });

    const navidromeMock = {
      browsing: {
        getAlbumList: mock(() =>
          Promise.resolve([
            { id: 'album-1', name: 'Alpha', artist: 'Artist A' },
            { id: 'album-2', name: 'Beta', artist: 'Artist B' },
          ]),
        ),
        getAlbum: mock((albumId: string) => {
          if (albumId === 'album-1') {
            return Promise.resolve({
              songs: [
                {
                  id: 'song-1',
                  title: 'First',
                  artist: 'Artist A',
                  album: 'Alpha',
                  path: 'Artist A/Alpha/01 - First.mp3',
                  created: '2026-03-20T10:00:00.000Z',
                },
                {
                  id: 'song-2',
                  title: 'Second',
                  artist: 'Artist A',
                  album: 'Alpha',
                  path: 'Artist A/Alpha/02 - Second.mp3',
                  created: '2026-03-20T09:00:00.000Z',
                },
              ],
            });
          }

          return Promise.resolve({
            songs: [
              {
                id: 'song-3',
                title: 'Third',
                artist: 'Artist B',
                album: 'Beta',
                path: 'Artist B/Beta/01 - Third.mp3',
                created: '2026-03-20T08:00:00.000Z',
              },
            ],
          });
        }),
      },
    };

    app = new Hono();
    app.route('/', libraryRoutes(navidromeMock as unknown as Parameters<typeof libraryRoutes>[0], '/music'));
  });

  afterEach(() => {
    testDb.close();
  });

  it('orders songs by completion timestamp when history exists', async () => {
    const db = testDb;
    db.run(
      `INSERT INTO completed_downloads
       (transfer_key, username, directory, filename, relative_path, basename, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        'user-1:transfer-1',
        'user-1',
        'Artist A/Alpha',
        'Artist A/Alpha/01 - First.mp3',
        'Artist A/Alpha/01 - First.mp3',
        '01 - first.mp3',
        1000,
      ],
    );
    db.run(
      `INSERT INTO completed_downloads
       (transfer_key, username, directory, filename, relative_path, basename, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        'user-1:transfer-2',
        'user-1',
        'Artist A/Alpha',
        'Artist A/Alpha/02 - Second.mp3',
        'Artist A/Alpha/02 - Second.mp3',
        '02 - second.mp3',
        3000,
      ],
    );
    db.run(
      `INSERT INTO completed_downloads
       (transfer_key, username, directory, filename, relative_path, basename, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        'user-1:transfer-3',
        'user-1',
        'Artist B/Beta',
        'Artist B/Beta/01 - Third.mp3',
        'Artist B/Beta/01 - Third.mp3',
        '01 - third.mp3',
        2000,
      ],
    );

    const res = await app.request('/recent-songs?size=10');
    expect(res.status).toBe(200);

    const data = await res.json() as Array<{ id: string }>;
    expect(data.map((s) => s.id)).toEqual(['song-2', 'song-3', 'song-1']);
  });

  it('falls back to created-time ordering when history is unavailable', async () => {
    const db = testDb;
    db.run('DELETE FROM completed_downloads');

    const res = await app.request('/recent-songs?size=10');
    expect(res.status).toBe(200);

    const data = await res.json() as Array<{ id: string }>;
    expect(data.map((s) => s.id)).toEqual(['song-1', 'song-2', 'song-3']);
  });
});
