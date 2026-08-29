import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { recordPlayEvents } from '../services/play-history.js';
import { upsertArtistOrigin } from '../services/artist-origins.js';
import { DESCRIPTOR_VERSION, upsertDescriptors } from '../services/descriptor-store.js';
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

  it('attaches descriptor blocks to pool members and seeds a descriptor centroid (formula v5)', () => {
    seedSong(testDb, { id: 'd1', title: 'D1', artist: 'A', albumId: 'a1', album: 'A1', bpm: 120 });
    seedSong(testDb, { id: 'd2', title: 'D2', artist: 'B', albumId: 'a2', album: 'A2', bpm: 121 });
    seedSong(testDb, { id: 'd3', title: 'D3', artist: 'C', albumId: 'a3', album: 'A3', bpm: 122 });
    const features = (centroid: number): Record<string, number | null> => {
      const f: Record<string, number | null> = {};
      for (let i = 0; i < 13; i++) f[`mfcc_${i}`] = i === 0 ? centroid : 0;
      for (const n of [
        'spectral_centroid',
        'spectral_bandwidth',
        'spectral_rolloff',
        'spectral_flux',
        'spectral_flatness',
        'spectral_complexity',
        'zero_crossing_rate',
        'pitch_salience',
        'onset_rate',
        'beat_strength',
        'tempo_stability',
        'swing_ratio',
        'groove_regularity',
        'syncopation',
        'danceability_dsp',
        'kick_weight',
      ])
        f[n] = 0.5;
      f.band_sub_bass = 0.1;
      f.band_bass = 0.5;
      f.band_low_mid = 0.1;
      f.band_mid = 0.2;
      f.band_high_mid = 0.05;
      f.band_high = 0.05;
      return f;
    };
    upsertDescriptors(testDb, { songId: 'd1', version: DESCRIPTOR_VERSION, features: features(-600), fileSize: 0 });
    upsertDescriptors(testDb, { songId: 'd2', version: DESCRIPTOR_VERSION, features: features(-700), fileSize: 0 });
    // d3 has no descriptors: it must still be in the pool, blocks undefined.
    const result = buildFilterRadio(testDb, { bpmMin: 1 }, {});
    const byId = new Map(result.pool.map((c) => [c._row.id, c]));
    expect(byId.get('d1')?.timbre).toHaveLength(21);
    expect(byId.get('d1')?.groove).toHaveLength(8);
    expect(byId.get('d1')?.bands).toHaveLength(6);
    expect(byId.get('d3')?.timbre).toBeUndefined();
    expect(byId.get('d3')).toBeDefined();
    // The station seed is the centroid of the members that carry blocks.
    expect(result.seed?.timbre).toHaveLength(21);
    expect(result.seed?.bands?.[1]).toBeCloseTo(0.5);
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
 * Stations (filter radio, formula v3). Membership in a genre station is a tag
 * test, so it is boolean and every candidate passes it — these cover the three
 * things that made an "Electronic" station serve Queen next to Calvin Harris.
 */
describe('radio /next — genre stations', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  /** Give a song a full ordered genre set (the join table the filter reads). */
  function setGenres(db: Database, songId: string, genres: string[]): void {
    genres.forEach((g, i) =>
      db.run(
        `INSERT OR REPLACE INTO library_song_genres (song_id, genre, position) VALUES (?, ?, ?)`,
        [songId, g, i],
      ),
    );
    db.run(`UPDATE library_songs SET genre = ? WHERE id = ?`, [genres[0] ?? null, songId]);
  }

  function embed(db: Database, id: string, v: number[]): void {
    db.run(
      `INSERT INTO library_embeddings (song_id, model, dim, vec, updated_at) VALUES (?, 'test', ?, ?, 0)`,
      [id, v.length, Buffer.from(new Float32Array(v).buffer)],
    );
  }

  it('grades membership: a genre native outranks an identically-fitting marginal tag', () => {
    // Calvin: every track Electronic-primary (share 1.0, depth 1.0).
    for (const i of [1, 2, 3]) {
      seedSong(testDb, {
        id: `calvin${i}`,
        title: `C${i}`,
        artist: 'Calvin',
        artistId: 'calvin',
        albumId: 'calvinAlb',
        album: 'Calvin Alb',
        bpm: 128,
        year: 2014,
      });
      setGenres(testDb, `calvin${i}`, ['Electronic']);
    }
    // Queen: one track wears Electronic third; the rest are Rock (share 0.1).
    for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      seedSong(testDb, {
        id: `queen${i}`,
        title: `Q${i}`,
        artist: 'Queen',
        artistId: 'queen',
        albumId: 'queenAlb',
        album: 'Queen Alb',
        bpm: 128,
        year: 2014,
      });
      setGenres(testDb, `queen${i}`, i === 1 ? ['Rock', 'Pop', 'Electronic'] : ['Rock']);
    }

    const result = buildFilterRadio(testDb, { genres: ['Electronic'] }, { count: 10 });
    const affinity = new Map(result.pool.map((c) => [c._row.id, c.stationAffinity]));
    // Both are members — the demotion is never an exclusion.
    expect(affinity.has('queen1')).toBe(true);
    expect(affinity.get('calvin1')!).toBeGreaterThan(affinity.get('queen1')!);

    // Every other axis is identical (same bpm/year/duration), so affinity is
    // the only thing that can order these.
    const ids = result.ranked.map((e) => e.song._row.id);
    expect(ids.indexOf('calvin1')).toBeLessThan(ids.indexOf('queen1'));
  });

  it("seeds the genre axis from the request, not the pool's modal primary", () => {
    // An umbrella tag that mostly sits on pop records: 4 of 5 members are
    // Pop-primary, so `seedCentroid`'s mode() returns "Pop" — the centroid
    // would have scored real Electronic tracks at 0 on the axis meant to
    // reward them.
    for (const i of [1, 2, 3, 4]) {
      seedSong(testDb, {
        id: `pop${i}`,
        title: `P${i}`,
        artist: 'PopStar',
        artistId: `pop${i}`,
        albumId: 'popAlb',
        album: 'Pop Alb',
      });
      setGenres(testDb, `pop${i}`, ['Pop', 'Electronic']);
    }
    seedSong(testDb, {
      id: 'real',
      title: 'Real',
      artist: 'Producer',
      artistId: 'producer',
      albumId: 'prodAlb',
      album: 'Prod Alb',
    });
    setGenres(testDb, 'real', ['Electronic']);

    const result = buildFilterRadio(testDb, { genres: ['Electronic'] }, {});
    expect(result.seed?.genre).toBe('Pop'); // the raw statistic, unchanged
    expect(result.seed?.genres).toEqual(['Electronic']); // what actually scores
  });

  it('loads embeddings for a station pool (they never were before v3)', () => {
    for (const i of [1, 2, 3]) {
      seedSong(testDb, {
        id: `s${i}`,
        title: `S${i}`,
        artist: `A${i}`,
        artistId: `a${i}`,
        albumId: `alb${i}`,
        album: `Alb ${i}`,
      });
      setGenres(testDb, `s${i}`, ['Electronic']);
      embed(testDb, `s${i}`, [1, 0, 0]);
    }

    const result = buildFilterRadio(testDb, { genres: ['Electronic'] }, {});
    expect(result.pool.every((c) => c.embedding !== undefined)).toBe(true);
    expect(result.seed?.embedding).toBeDefined();
    // The anchor is L2-normalised, so an all-aligned pool anchors on that axis.
    expect(result.seed!.embedding![0]!).toBeCloseTo(1, 5);
  });

  it('leaves a genre-less vibe on the plain genre axis', () => {
    seedSong(testDb, { id: 'x', title: 'X', artist: 'A', albumId: 'a1', album: 'A1', bpm: 120 });
    setGenres(testDb, 'x', ['Rock']);
    const result = buildFilterRadio(testDb, { bpmMin: 1 }, {});
    expect(result.pool.every((c) => c.stationAffinity === undefined)).toBe(true);
  });

  it('ignores a junk station genre rather than grading against a shrug', () => {
    seedSong(testDb, { id: 'j', title: 'J', artist: 'A', albumId: 'a1', album: 'A1' });
    setGenres(testDb, 'j', ['Other']);
    const result = buildFilterRadio(testDb, { genres: ['Other'] }, {});
    expect(result.pool.every((c) => c.stationAffinity === undefined)).toBe(true);
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

describe('radio pool duration floor (issue #583)', () => {
  function seedThree(): void {
    testDb = createTestDb();
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
      id: 'ok',
      title: 'Ok',
      artist: 'B',
      albumId: 'alb2',
      album: 'Alb 2',
      genre: 'Rock',
      bpm: 120,
    });
    seedSong(testDb, {
      id: 'short',
      title: 'Short',
      artist: 'C',
      albumId: 'alb3',
      album: 'Alb 3',
      genre: 'Rock',
      bpm: 120,
    });
    // The helper inserts duration 240; make this one an intro/skit-length row.
    testDb.run("UPDATE library_songs SET duration = 30 WHERE id = 'short'");
  }

  it('a sub-60s track is never a candidate', async () => {
    seedThree();
    const app = new Hono();
    app.route('/radio', radioRoutes());
    const res = await app.request('/radio/next?seedId=seed&count=10');
    const ids = ((await res.json()) as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toContain('ok');
    expect(ids).not.toContain('short');
  });

  it('NICOTIND_RADIO_MIN_DURATION=0 re-admits it (the e2e fixture path)', async () => {
    seedThree();
    process.env.NICOTIND_RADIO_MIN_DURATION = '0';
    try {
      const app = new Hono();
      app.route('/radio', radioRoutes());
      const res = await app.request('/radio/next?seedId=seed&count=10');
      const ids = ((await res.json()) as Array<{ id: string }>).map((s) => s.id);
      expect(ids).toContain('short');
    } finally {
      delete process.env.NICOTIND_RADIO_MIN_DURATION;
    }
  });
});

describe('radio /next — list-seeded ("keep the vibe", seedIds)', () => {
  let app: Hono;

  beforeEach(() => {
    testDb = createTestDb();
    app = new Hono();
    app.route('/radio', radioRoutes());
    seedSong(testDb, {
      id: 'seed1',
      title: 'Seed 1',
      artist: 'A',
      artistId: 'A',
      albumId: 'alb1',
      album: 'Alb 1',
      genre: 'Rock',
      bpm: 120,
      year: 2020,
    });
    seedSong(testDb, {
      id: 'seed2',
      title: 'Seed 2',
      artist: 'B',
      artistId: 'B',
      albumId: 'alb2',
      album: 'Alb 2',
      genre: 'Rock',
      bpm: 124,
      year: 2019,
    });
    seedSong(testDb, {
      id: 'rockVar',
      title: 'Rock Variation',
      artist: 'C',
      artistId: 'C',
      albumId: 'alb3',
      album: 'Alb 3',
      genre: 'Rock',
      bpm: 122,
      year: 2021,
    });
    seedSong(testDb, {
      id: 'farOff',
      title: 'Far Off',
      artist: 'D',
      artistId: 'D',
      albumId: 'alb4',
      album: 'Alb 4',
      genre: 'Classical',
      bpm: 60,
      year: 1970,
    });
  });

  it('recommends variations of the list — never the seeds themselves', async () => {
    const res = await app.request('/radio/next?seedIds=seed1,seed2&count=5');
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as Array<{ id: string }>).map((s) => s.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).not.toContain('seed1');
    expect(ids).not.toContain('seed2');
    // The centroid (Rock, ~122bpm, ~2020) ranks the in-vibe candidate first.
    expect(ids[0]).toBe('rockVar');
  });

  it('skips unknown seed ids but still serves from the resolvable ones', async () => {
    const res = await app.request('/radio/next?seedIds=deleted-long-ago,seed1&count=5');
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as Array<{ id: string }>).map((s) => s.id);
    expect(ids).not.toContain('seed1');
    expect(ids).toContain('rockVar');
  });

  it('404s only when no seed id resolves at all', async () => {
    const res = await app.request('/radio/next?seedIds=nope,also-nope');
    expect(res.status).toBe(404);
  });

  it('respects the exclude list on top of the seed exclusion', async () => {
    const res = await app.request('/radio/next?seedIds=seed1,seed2&exclude=rockVar&count=5');
    const ids = ((await res.json()) as Array<{ id: string }>).map((s) => s.id);
    expect(ids).not.toContain('rockVar');
  });
});
