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

  // `popularity` crosses the wire so the client can size things by hotness.
  // The absent case is the one that matters: normalizePopularity maps a real
  // zero-listen recording to 0, so a client seeing 0 where we simply never
  // scored the song would treat "unknown" as "nobody listens to this".
  it('surfaces popularity, and omits it entirely when never scored', async () => {
    testDb.run(`UPDATE library_songs SET popularity = 0.72 WHERE id = 'song-1'`);
    const res = await app.request('/songs');
    const data = (await res.json()) as Array<{ id: string; popularity?: number }>;
    const byId = new Map(data.map((s) => [s.id, s]));
    expect(byId.get('song-1')?.popularity).toBe(0.72);
    expect('popularity' in (byId.get('song-2') as object)).toBe(false);
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
    // Every token must appear somewhere in "title + artist + album", so this
    // matches song-3 by its album ("Bravo Two") AND song-2, whose artist
    // carries "Bravo" and whose album is "Two". A substring `LIKE '%bravo
    // two%'` found only the first; per-token AND is the shared matcher's
    // documented semantics and what the find bar has always done.
    expect(data.map((s) => s.id).sort()).toEqual(['song-2', 'song-3']);
  });

  it('a wildcard-only query matches nothing, never everything', async () => {
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
    // A bare `%` used to reach SQL, where un-escaped it would have built
    // `LIKE '%%%'` and matched every song. Tokenizing splits on every
    // non-alphanumeric, so `%` yields no tokens at all and there is nothing to
    // match — the same protection, now structural rather than an escape.
    // Searching for a literal `%` is no longer possible; "100" or "pure" finds
    // the same song, and no other search surface supports it either.
    const res = await app.request('/songs?q=%25');
    const data = (await res.json()) as Array<{ id: string }>;
    expect(data.map((s) => s.id)).toEqual([]);
  });

  it('a punctuation-only query matches nothing', async () => {
    expect(
      ((await (await app.request('/songs?q=...')).json()) as Array<{ id: string }>).map(
        (s) => s.id,
      ),
    ).toEqual([]);
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

  // issue #719 — this box matched with `LIKE ? COLLATE NOCASE`, which is
  // ASCII-only, while the cross-type find bar in the same file already folded.
  describe('accent-insensitive matching', () => {
    const ids = async (url: string): Promise<string[]> => {
      const data = (await (await app.request(url)).json()) as Array<{ id: string }>;
      return data.map((s) => s.id);
    };

    beforeEach(() => {
      seedSong(testDb, {
        id: 'song-accent',
        title: 'Corazón Delator',
        artist: 'Soda Stereo',
        album: 'Canción Animal',
        albumId: 'album-accent',
        path: 'Soda Stereo/Cancion Animal/01.mp3',
        created: '2026-03-20T12:00:00.000Z',
      });
    });

    it('finds an accented title from an unaccented query', async () => {
      expect(await ids('/songs?q=corazon')).toEqual(['song-accent']);
    });

    it('finds an accented album name from an unaccented query', async () => {
      expect(await ids('/songs?q=cancion')).toEqual(['song-accent']);
    });

    it('finds an accented title typed in upper case', async () => {
      // NOCASE case-folds ASCII only, so "Ó" never equalled "ó" — even the
      // correctly-spelled query missed.
      expect(await ids('/songs?q=CORAZÓN')).toEqual(['song-accent']);
    });

    it('still matches when the query carries the accent', async () => {
      expect(await ids('/songs?q=corazón')).toEqual(['song-accent']);
    });

    it('pages a filtered result set correctly, in sort order', async () => {
      // Matching moved into JS, so `offset`/`size` had to move with it — the
      // SQL no longer carries LIMIT/OFFSET on this path. A slice applied to the
      // wrong side of the filter silently returns the wrong page.
      for (const n of [1, 2, 3, 4]) {
        seedSong(testDb, {
          id: `page-${n}`,
          title: `Página ${n}`,
          artist: 'Pager',
          album: 'Pages',
          albumId: 'album-pages',
          path: `Pager/Pages/0${n}.mp3`,
          created: `2026-03-2${n}T00:00:00.000Z`,
        });
      }
      // Unaccented query, sorted by title so the order is deterministic.
      expect(await ids('/songs?q=pagina&sort=title&size=2&offset=0')).toEqual(['page-1', 'page-2']);
      expect(await ids('/songs?q=pagina&sort=title&size=2&offset=2')).toEqual(['page-3', 'page-4']);
      expect(await ids('/songs?q=pagina&sort=title&size=2&offset=4')).toEqual([]);
    });
  });
});
