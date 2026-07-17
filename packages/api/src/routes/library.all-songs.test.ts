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
    db.run(`INSERT INTO library_song_genres (song_id, genre, position) VALUES (?, ?, 0)`, [
      s.id,
      s.genre,
    ]);
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

describe('library /songs free-text `q` parameter', () => {
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
    });
    seedSong(testDb, {
      id: 'song-2',
      title: 'Bravo',
      artist: 'Bravo the Singer',
      album: 'Two',
      albumId: 'album-2',
      path: 'Bravo/Two/01 - Bravo.mp3',
      created: '2026-03-20T09:00:00.000Z',
    });
    seedSong(testDb, {
      id: 'song-3',
      title: 'Charlie',
      artist: 'Artist C',
      album: 'Bravo Two',
      albumId: 'album-3',
      path: 'Artist C/Bravo Two/01 - Charlie.mp3',
      created: '2026-03-20T08:00:00.000Z',
    });

    app = new Hono();
    app.route('/', libraryRoutes('/music'));
  });

  afterEach(() => {
    testDb.close();
  });

  it('matches song title (partial, case-insensitive)', async () => {
    const res = await app.request('/songs?q=ALPH');
    const data = (await res.json()) as Array<{ id: string }>;
    expect(data.map((s) => s.id)).toEqual(['song-1']);
  });

  it('matches song artist (partial, case-insensitive)', async () => {
    const res = await app.request('/songs?q=bravo%20the');
    const data = (await res.json()) as Array<{ id: string }>;
    expect(data.map((s) => s.id)).toEqual(['song-2']);
  });

  it('matches album name (partial, case-insensitive)', async () => {
    const res = await app.request('/songs?q=bravo%20two');
    const data = (await res.json()) as Array<{ id: string }>;
    expect(data.map((s) => s.id)).toEqual(['song-3']);
  });

  it('escapes LIKE wildcards in the query so % / _ are literal', async () => {
    seedSong(testDb, {
      id: 'song-with-percent',
      title: '100%Pure',
      artist: 'Artist P',
      album: 'Promos',
      albumId: 'album-p',
      path: 'Artist P/Promos/01.mp3',
      created: '2026-03-20T07:00:00.000Z',
    });
    seedSong(testDb, {
      id: 'song-without-percent',
      title: 'A regular title',
      artist: 'Artist R',
      album: 'Regulars',
      albumId: 'album-r',
      path: 'Artist R/Regulars/01.mp3',
      created: '2026-03-20T07:30:00.000Z',
    });
    // A bare `%` query, un-escaped, would build `LIKE '%%%'` and match every
    // song; with the escape, `LIKE '%\%%'` only matches titles that literally
    // contain a `%` character.
    const res = await app.request('/songs?q=%25');
    const data = (await res.json()) as Array<{ id: string }>;
    expect(data.map((s) => s.id)).toEqual(['song-with-percent']);
  });

  it('combines with LibraryFilter (bpm range) and sort', async () => {
    // The base `song-1` ("Alpha") is seeded without bpm (defaults to null),
    // so it must fail the bpmMin floor; we seed a BPM-bearing Alpha to prove
    // AND-with-songFilterWheres keeps both predicates active.
    seedSong(testDb, {
      id: 'song-alpha-128',
      title: 'Alpha 128',
      artist: 'Artist A',
      album: 'One',
      albumId: 'album-1',
      path: 'Artist A/One/02 - Alpha 128.mp3',
      created: '2026-03-20T11:00:00.000Z',
      bpm: 128,
    });
    seedSong(testDb, {
      id: 'song-alpha-70',
      title: 'Alpha 70',
      artist: 'Artist A',
      album: 'One',
      albumId: 'album-1',
      path: 'Artist A/One/03 - Alpha 70.mp3',
      created: '2026-03-20T11:30:00.000Z',
      bpm: 70,
    });
    const res = await app.request('/songs?q=alpha&bpmMin=120&sort=title');
    const data = (await res.json()) as Array<{ id: string }>;
    expect(data.map((s) => s.id)).toEqual(['song-alpha-128']);
  });

  it('returns an empty page when no songs match', async () => {
    const res = await app.request('/songs?q=zzznotreal');
    const data = (await res.json()) as Array<{ id: string }>;
    expect(data).toEqual([]);
  });
});
