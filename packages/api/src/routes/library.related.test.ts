import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { libraryRoutes } from './library.js';
import { computeArtistCentroids, MIN_ARTIST_MEMBERS } from '../services/artist-centroids.js';

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

let songSeq = 0;

function seedAnalysedArtist(id: string, vec: number[]): void {
  testDb.run(`INSERT INTO library_artists (id, name, album_count, synced_at) VALUES (?, ?, 1, 0)`, [
    id,
    `Name ${id}`,
  ]);
  testDb.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, created, synced_at)
     VALUES (?, 'Album', ?, ?, 1, 0, '2024-01-01', 0)`,
    [`al-${id}`, id, id],
  );
  for (let i = 0; i < MIN_ARTIST_MEMBERS; i++) {
    const sid = `s${++songSeq}`;
    testDb.run(
      `INSERT INTO library_songs
        (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix,
         content_type, created, landed_at, synced_at)
       VALUES (?, ?, ?, ?, ?, 180, ?, 1000, 320, 'opus', 'audio/ogg', '2024-01-01', 1, 0)`,
      [sid, `al-${id}`, sid, id, id, `/music/${sid}.opus`],
    );
    testDb.run(
      `INSERT INTO library_song_artists (song_id, artist_id, role, position) VALUES (?, ?, 'primary', 0)`,
      [sid, id],
    );
    testDb.run(
      `INSERT INTO library_embeddings (song_id, model, dim, vec, file_size, updated_at)
       VALUES (?, 'm', ?, ?, 1000, 1)`,
      [sid, vec.length, Buffer.from(new Float32Array(vec).buffer)],
    );
  }
}

describe('GET /artists/:id/related', () => {
  let app: Hono;

  beforeEach(() => {
    testDb = new Database(':memory:');
    applySchema(testDb);
    songSeq = 0;
    app = new Hono();
    app.route('/', libraryRoutes('/music'));
  });

  afterEach(() => {
    testDb.close();
  });

  it('404s an unknown artist', async () => {
    const res = await app.request('/artists/nope/related');
    expect(res.status).toBe(404);
  });

  it('reports no signal for a known artist with no analysed tracks', async () => {
    testDb.run(`INSERT INTO library_artists (id, name, synced_at) VALUES ('bare', 'Bare', 0)`);
    const res = await app.request('/artists/bare/related');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ artists: [], reason: 'no-signal' });
  });

  it('returns the related row and clamps the limit', async () => {
    seedAnalysedArtist('seed', [1, 0]);
    seedAnalysedArtist('a', [1, 0.1]);
    seedAnalysedArtist('b', [1, 0.2]);
    computeArtistCentroids(testDb);

    const all = (await (await app.request('/artists/seed/related')).json()) as {
      artists: { id: string; name: string; signals: { audio?: { cosine: number } } }[];
    };
    expect(all.artists.map((a) => a.id)).toEqual(['a', 'b']);
    expect(all.artists[0]!.name).toBe('Name a');
    expect(all.artists[0]!.signals.audio!.cosine).toBeGreaterThan(0.9);

    const one = (await (await app.request('/artists/seed/related?limit=1')).json()) as {
      artists: unknown[];
    };
    expect(one.artists).toHaveLength(1);
    const junk = await app.request('/artists/seed/related?limit=banana');
    expect(((await junk.json()) as { artists: unknown[] }).artists).toHaveLength(2);
    const zero = await app.request('/artists/seed/related?limit=0');
    expect(((await zero.json()) as { artists: unknown[] }).artists).toHaveLength(1);
  });
});
