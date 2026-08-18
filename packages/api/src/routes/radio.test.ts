import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { recordPlayEvents } from '../services/play-history.js';
import { upsertArtistOrigin } from '../services/artist-origins.js';
import { radioRoutes, buildFilterRadio } from './radio.js';

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
    artistId?: string;
    album: string;
    albumId: string;
    genre?: string;
    bpm?: number;
    key?: string;
    year?: number;
  },
): void {
  const artistId = s.artistId ?? s.artist;
  db.run(
    `INSERT OR IGNORE INTO library_albums (id, name, artist, artist_id, song_count, duration, year, genre, created, synced_at)
     VALUES (?, ?, ?, ?, 1, 0, ?, ?, '2024-01-01', 0)`,
    [s.albumId, s.album, s.artist, artistId, s.year ?? null, s.genre ?? null],
  );
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, genre, bpm, key, year, landed_at, synced_at)
     VALUES (?, ?, ?, ?, ?, 240, '/music/test.mp3', 0, 320, 'mp3', 'audio/mpeg', '2024-01-01', ?, ?, ?, ?, 1, 0)`,
    [
      s.id,
      s.albumId,
      s.title,
      s.artist,
      artistId,
      s.genre ?? null,
      s.bpm ?? null,
      s.key ?? null,
      s.year ?? null,
    ],
  );
}

describe('radio /next', () => {
  let app: Hono;

  beforeEach(() => {
    testDb = createTestDb();
    app = new Hono();
    app.route('/radio', radioRoutes());
  });

  it('returns 400 without seedId', async () => {
    const res = await app.request('/radio/next');
    expect(res.status).toBe(400);
  });

  it('returns 404 for nonexistent seed', async () => {
    const res = await app.request('/radio/next?seedId=nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns songs ranked by similarity to the seed', async () => {
    seedSong(testDb, {
      id: 'seed',
      title: 'Seed',
      artist: 'A',
      albumId: 'alb1',
      album: 'Alb 1',
      genre: 'Rock',
      bpm: 120,
      key: 'C major',
      year: 2020,
    });
    seedSong(testDb, {
      id: 'similar',
      title: 'Similar',
      artist: 'B',
      artistId: 'B',
      albumId: 'alb2',
      album: 'Alb 2',
      genre: 'Rock',
      bpm: 122,
      key: 'G major',
      year: 2019,
    });
    seedSong(testDb, {
      id: 'distant',
      title: 'Distant',
      artist: 'C',
      artistId: 'C',
      albumId: 'alb3',
      album: 'Alb 3',
      genre: 'Classical',
      bpm: 60,
      key: 'F# minor',
      year: 1970,
    });

    const res = await app.request('/radio/next?seedId=seed&count=10');
    expect(res.status).toBe(200);
    const songs = await res.json();
    expect(songs.length).toBeGreaterThanOrEqual(2);
    expect(songs[0].id).toBe('similar');
  });

  it('excludes specified song IDs', async () => {
    seedSong(testDb, {
      id: 'seed',
      title: 'Seed',
      artist: 'A',
      albumId: 'alb1',
      album: 'Alb 1',
      genre: 'Rock',
      bpm: 120,
    });
    seedSong(testDb, {
      id: 'excluded',
      title: 'Excluded',
      artist: 'B',
      artistId: 'B',
      albumId: 'alb2',
      album: 'Alb 2',
      genre: 'Rock',
      bpm: 120,
    });
    seedSong(testDb, {
      id: 'kept',
      title: 'Kept',
      artist: 'C',
      artistId: 'C',
      albumId: 'alb3',
      album: 'Alb 3',
      genre: 'Rock',
      bpm: 120,
    });

    const res = await app.request('/radio/next?seedId=seed&exclude=excluded');
    const songs = await res.json();
    const ids = songs.map((s: { id: string }) => s.id);
    expect(ids).not.toContain('excluded');
    expect(ids).not.toContain('seed');
  });

  it('never includes the seed song in results', async () => {
    seedSong(testDb, {
      id: 'seed',
      title: 'Seed',
      artist: 'A',
      albumId: 'alb1',
      album: 'Alb 1',
      genre: 'Rock',
      bpm: 120,
    });
    seedSong(testDb, {
      id: 'other',
      title: 'Other',
      artist: 'B',
      artistId: 'B',
      albumId: 'alb2',
      album: 'Alb 2',
      genre: 'Rock',
      bpm: 120,
    });

    const res = await app.request('/radio/next?seedId=seed');
    const songs = await res.json();
    const ids = songs.map((s: { id: string }) => s.id);
    expect(ids).not.toContain('seed');
  });

  it('returns songs with key field when available', async () => {
    seedSong(testDb, {
      id: 'seed',
      title: 'Seed',
      artist: 'A',
      albumId: 'alb1',
      album: 'Alb 1',
      genre: 'Rock',
      bpm: 120,
      key: 'C major',
    });
    seedSong(testDb, {
      id: 'match',
      title: 'Match',
      artist: 'B',
      artistId: 'B',
      albumId: 'alb2',
      album: 'Alb 2',
      genre: 'Rock',
      bpm: 120,
      key: 'G major',
    });

    const res = await app.request('/radio/next?seedId=seed');
    const songs = await res.json();
    expect(songs.length).toBeGreaterThanOrEqual(1);
    expect(songs[0].key).toBe('G major');
  });

  it('respects count parameter', async () => {
    seedSong(testDb, {
      id: 'seed',
      title: 'Seed',
      artist: 'A',
      albumId: 'alb1',
      album: 'Alb 1',
      genre: 'Pop',
    });
    for (let i = 0; i < 10; i++) {
      seedSong(testDb, {
        id: `s${i}`,
        title: `Song ${i}`,
        artist: `Art${i}`,
        artistId: `art${i}`,
        albumId: `alb${i + 10}`,
        album: `Alb ${i}`,
        genre: 'Pop',
      });
    }

    const res = await app.request('/radio/next?seedId=seed&count=3');
    const songs = await res.json();
    expect(songs.length).toBe(3);
  });

  it('falls back to random pool when no genre/bpm match', async () => {
    seedSong(testDb, { id: 'seed', title: 'Seed', artist: 'A', albumId: 'alb1', album: 'Alb 1' });
    seedSong(testDb, {
      id: 'random',
      title: 'Random',
      artist: 'B',
      artistId: 'B',
      albumId: 'alb2',
      album: 'Alb 2',
    });

    const res = await app.request('/radio/next?seedId=seed');
    const songs = await res.json();
    expect(songs.length).toBeGreaterThanOrEqual(1);
  });

  it('surfaces un-analyzed (bpm-less) tracks via the dedicated pool', async () => {
    seedSong(testDb, {
      id: 'seed',
      title: 'Seed',
      artist: 'A',
      albumId: 'alb1',
      album: 'Alb 1',
      genre: 'Rock',
      bpm: 120,
    });
    // No genre and no bpm: only reachable through the un-analyzed pool pass.
    seedSong(testDb, {
      id: 'raw',
      title: 'Raw',
      artist: 'B',
      artistId: 'B',
      albumId: 'alb2',
      album: 'Alb 2',
    });

    const res = await app.request('/radio/next?seedId=seed');
    const ids = (await res.json()).map((s: { id: string }) => s.id);
    expect(ids).toContain('raw');
  });

  it('matches genre variants (Deep House ↔ House) and ranks them above disjoint genres', async () => {
    seedSong(testDb, {
      id: 'seed',
      title: 'Seed',
      artist: 'A',
      albumId: 'alb1',
      album: 'Alb 1',
      genre: 'Deep House',
      bpm: 120,
    });
    seedSong(testDb, {
      id: 'variant',
      title: 'Variant',
      artist: 'B',
      artistId: 'B',
      albumId: 'alb2',
      album: 'Alb 2',
      genre: 'House',
      bpm: 121,
    });
    seedSong(testDb, {
      id: 'unrelated',
      title: 'Unrelated',
      artist: 'C',
      artistId: 'C',
      albumId: 'alb3',
      album: 'Alb 3',
      genre: 'Death Metal',
      bpm: 121,
    });

    const res = await app.request('/radio/next?seedId=seed');
    const ids = (await res.json()).map((s: { id: string }) => s.id);
    expect(ids).toContain('variant');
    expect(ids.indexOf('variant')).toBeLessThan(ids.indexOf('unrelated'));
  });

  // --- Filter-seeded radio (no seed song, a LibraryFilter "vibe") ---

  it('filter radio: returns only songs matching a bpm floor', async () => {
    seedSong(testDb, {
      id: 'fast1',
      title: 'Fast 1',
      artist: 'A',
      albumId: 'a1',
      album: 'A1',
      genre: 'Rock',
      bpm: 128,
    });
    seedSong(testDb, {
      id: 'fast2',
      title: 'Fast 2',
      artist: 'B',
      artistId: 'B',
      albumId: 'a2',
      album: 'A2',
      genre: 'Rock',
      bpm: 140,
    });
    seedSong(testDb, {
      id: 'slow',
      title: 'Slow',
      artist: 'C',
      artistId: 'C',
      albumId: 'a3',
      album: 'A3',
      genre: 'Rock',
      bpm: 90,
    });

    const res = await app.request('/radio/next?bpmMin=120');
    expect(res.status).toBe(200);
    const ids = (await res.json()).map((s: { id: string }) => s.id);
    expect(ids).toContain('fast1');
    expect(ids).toContain('fast2');
    expect(ids).not.toContain('slow');
  });

  it('filter radio: returns only songs matching a genre', async () => {
    seedSong(testDb, {
      id: 'rock',
      title: 'Rock',
      artist: 'A',
      albumId: 'a1',
      album: 'A1',
      genre: 'Rock',
    });
    seedSong(testDb, {
      id: 'jazz',
      title: 'Jazz',
      artist: 'B',
      artistId: 'B',
      albumId: 'a2',
      album: 'A2',
      genre: 'Jazz',
    });

    const res = await app.request('/radio/next?genre=Rock');
    expect(res.status).toBe(200);
    const ids = (await res.json()).map((s: { id: string }) => s.id);
    expect(ids).toContain('rock');
    expect(ids).not.toContain('jazz');
  });

  it('filter radio: honors count and excludes ids', async () => {
    for (let i = 0; i < 6; i++) {
      seedSong(testDb, {
        id: `p${i}`,
        title: `P${i}`,
        artist: `Ar${i}`,
        artistId: `ar${i}`,
        albumId: `al${i}`,
        album: `Al${i}`,
        genre: 'Pop',
      });
    }
    const res = await app.request('/radio/next?genre=Pop&count=2&exclude=p0');
    expect(res.status).toBe(200);
    const ids = (await res.json()).map((s: { id: string }) => s.id);
    expect(ids.length).toBe(2);
    expect(ids).not.toContain('p0');
  });

  it('filter radio: returns [] (200) when nothing matches', async () => {
    seedSong(testDb, {
      id: 'only',
      title: 'Only',
      artist: 'A',
      albumId: 'a1',
      album: 'A1',
      genre: 'Rock',
      bpm: 90,
    });
    const res = await app.request('/radio/next?bpmMin=999');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('filter radio: the centroid carries a genre for a genre-uniform pool (issue #187 B4)', () => {
    seedSong(testDb, {
      id: 'r1',
      title: 'R1',
      artist: 'A',
      albumId: 'a1',
      album: 'A1',
      genre: 'Rock',
    });
    seedSong(testDb, {
      id: 'r2',
      title: 'R2',
      artist: 'B',
      artistId: 'B',
      albumId: 'a2',
      album: 'A2',
      genre: 'Rock',
    });
    const result = buildFilterRadio(testDb, { genres: ['Rock'] }, {});
    // Before the fix, toOrderable never copied `genre` onto OrderableRow, so
    // seedCentroid's mode() always saw an all-undefined array and the centroid
    // came back genre-less — meaning genre was SKIPPED for every candidate,
    // not merely weighted low. A genre-uniform pool's centroid must reflect it.
    expect(result.seed?.genre).toBe('Rock');
  });

  it('ranks a same-country candidate above a cross-world one when all else is equal', async () => {
    seedSong(testDb, {
      id: 'seed',
      title: 'Seed',
      artist: 'A',
      albumId: 'a1',
      album: 'A1',
      bpm: 120,
    });
    seedSong(testDb, {
      id: 'compat',
      title: 'Compat',
      artist: 'B',
      albumId: 'a2',
      album: 'A2',
      bpm: 120,
    });
    seedSong(testDb, {
      id: 'foreign',
      title: 'Foreign',
      artist: 'C',
      albumId: 'a3',
      album: 'A3',
      bpm: 120,
    });
    upsertArtistOrigin(testDb, { artistId: 'A', country: 'AR', source: 'musicbrainz' });
    upsertArtistOrigin(testDb, { artistId: 'B', country: 'AR', source: 'musicbrainz' });
    upsertArtistOrigin(testDb, { artistId: 'C', country: 'GB', source: 'musicbrainz' });
    const res = await app.request('/radio/next?seedId=seed&limit=2');
    expect(res.status).toBe(200);
    const songs = (await res.json()) as Array<{ id: string }>;
    expect(songs.map((s) => s.id)).toEqual(['compat', 'foreign']);
  });

  it('filter radio: the centroid carries the modal origin for an origin-uniform pool', () => {
    seedSong(testDb, { id: 'o1', title: 'O1', artist: 'A', albumId: 'a1', album: 'A1', bpm: 120 });
    seedSong(testDb, { id: 'o2', title: 'O2', artist: 'B', albumId: 'a2', album: 'A2', bpm: 122 });
    upsertArtistOrigin(testDb, { artistId: 'A', country: 'AR', source: 'musicbrainz' });
    upsertArtistOrigin(testDb, { artistId: 'B', country: 'AR', source: 'musicbrainz' });
    const result = buildFilterRadio(testDb, { bpmMin: 1 }, {});
    // toOrderable is the documented silent-kill spot (issue #187 B4's lesson):
    // a column left out of it never reaches seedCentroid, and the axis silently
    // dies for every filter-radio candidate.
    expect(result.seed?.originCountries).toEqual(['AR']);
  });

  it('still returns results when embeddings are present for some songs', async () => {
    seedSong(testDb, {
      id: 'seed',
      title: 'Seed',
      artist: 'A',
      albumId: 'alb1',
      album: 'Alb 1',
      genre: 'Rock',
      bpm: 120,
    });
    seedSong(testDb, {
      id: 'aligned',
      title: 'Aligned',
      artist: 'B',
      artistId: 'B',
      albumId: 'alb2',
      album: 'Alb 2',
      genre: 'Rock',
      bpm: 120,
    });
    seedSong(testDb, {
      id: 'opposed',
      title: 'Opposed',
      artist: 'C',
      artistId: 'C',
      albumId: 'alb3',
      album: 'Alb 3',
      genre: 'Rock',
      bpm: 120,
    });
    const embed = (id: string, v: number[]) =>
      testDb.run(
        `INSERT INTO library_embeddings (song_id, model, dim, vec, updated_at) VALUES (?, 'test', ?, ?, 0)`,
        [id, v.length, Buffer.from(new Float32Array(v).buffer)],
      );
    embed('seed', [1, 0, 0]);
    embed('aligned', [1, 0, 0]);
    embed('opposed', [-1, 0, 0]);

    const res = await app.request('/radio/next?seedId=seed');
    const ids = (await res.json()).map((s: { id: string }) => s.id);
    // The embedding axis breaks the otherwise-identical tie toward 'aligned'.
    expect(ids.indexOf('aligned')).toBeLessThan(ids.indexOf('opposed'));
  });
});

/**
 * Recently-played demotion end-to-end (P3). The scorer's arithmetic is unit
 * tested in radio.service.test.ts; what matters here is that the per-user
 * lookup actually reaches ranking, and that an unidentified caller is
 * unaffected.
 */
describe('radio /next — recently-played demotion', () => {
  let app: Hono;

  /** Mount with an injected authed user, the way index.ts would if radio were gated. */
  function appAs(userId: string | null): Hono {
    const a = new Hono();
    if (userId) {
      a.use('*', async (c, next) => {
        (c as unknown as { set: (k: string, v: unknown) => void }).set('user', { sub: userId });
        await next();
      });
    }
    a.route('/radio', radioRoutes());
    return a;
  }

  beforeEach(() => {
    testDb = createTestDb();
    testDb.run("INSERT INTO users (id, username, password_hash) VALUES ('u1','a','x')");
    // Seed + two equally-good candidates, differing only in recent play.
    seedSong(testDb, {
      id: 'seed',
      title: 'Seed',
      artist: 'A0',
      album: 'Al',
      albumId: 'al',
      genre: 'Rock',
      bpm: 120,
    });
    seedSong(testDb, {
      id: 'fresh',
      title: 'Fresh',
      artist: 'A1',
      album: 'Al',
      albumId: 'al',
      genre: 'Rock',
      bpm: 120,
    });
    seedSong(testDb, {
      id: 'recent',
      title: 'Recent',
      artist: 'A2',
      album: 'Al',
      albumId: 'al',
      genre: 'Rock',
      bpm: 120,
    });
    app = appAs('u1');
  });

  function playedNow(songId: string): void {
    recordPlayEvents(testDb, 'u1', [
      {
        clientEventId: `e-${songId}`,
        songId,
        startedAt: Date.now(),
        msPlayed: 200_000,
        durationMs: 300_000,
        reason: 'ended',
        source: null,
        device: null,
        title: null,
        artist: null,
        album: null,
      },
    ]);
  }

  it('ranks a just-played track below an equally-good untouched one', async () => {
    playedNow('recent');
    const res = await app.request('/radio/next?seedId=seed&count=2');
    const songs = (await res.json()) as Array<{ id: string }>;
    expect(songs.map((s) => s.id)).toEqual(['fresh', 'recent']);
  });

  it('leaves ranking alone when nothing was played recently', async () => {
    const res = await app.request('/radio/next?seedId=seed&count=2');
    const songs = (await res.json()) as Array<{ id: string }>;
    // Both still present — the demotion is a nudge, never an exclusion.
    expect(songs.map((s) => s.id).sort()).toEqual(['fresh', 'recent']);
  });

  it('still returns the track — demoted, not excluded', async () => {
    playedNow('recent');
    playedNow('fresh');
    const res = await app.request('/radio/next?seedId=seed&count=5');
    const songs = (await res.json()) as Array<{ id: string }>;
    expect(songs.map((s) => s.id).sort()).toEqual(['fresh', 'recent']);
  });

  it('does not apply another user’s history', async () => {
    testDb.run("INSERT INTO users (id, username, password_hash) VALUES ('u2','b','y')");
    playedNow('recent');
    const other = await appAs('u2').request('/radio/next?seedId=seed&count=2');
    const songs = (await other.json()) as Array<{ id: string }>;
    expect(songs).toHaveLength(2);
  });

  it('serves an unidentified caller without erroring', async () => {
    // /api/radio is not behind the JWT middleware today, so this is the
    // production path — it must degrade to "no demotion", not a 500.
    playedNow('recent');
    const res = await appAs(null).request('/radio/next?seedId=seed&count=2');
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toHaveLength(2);
  });
});
