import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  computeGenreCentroids,
  countGenreCentroids,
  listGenreCentroids,
  loadGenreAffinity,
  loadGenreCentroids,
  maybeRunDailyGenreCentroids,
} from './genre-centroids.js';

const MODEL = 'discogs-effnet-bs64-1';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
     VALUES ('al', 'Album', 'Artist', 'art', 1, 0, 1)`,
  );
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at, hidden)
     VALUES ('al-hidden', 'Hidden', 'Artist', 'art', 1, 0, 1, 1)`,
  );
});

function seedSong(
  id: string,
  opts: { genre?: string | null; genres?: string[]; hidden?: number; albumId?: string } = {},
): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, genre, hidden, created, synced_at)
     VALUES (?, ?, ?, 'Artist', 'art', 200, ?, 1000, ?, ?, '2024-01-01', 1)`,
    [id, opts.albumId ?? 'al', id, `Artist/Album/${id}.opus`, opts.genre ?? null, opts.hidden ?? 0],
  );
  (opts.genres ?? []).forEach((g, i) =>
    db.run(`INSERT INTO library_song_genres (song_id, genre, position) VALUES (?, ?, ?)`, [
      id,
      g,
      i,
    ]),
  );
}

function seedEmbedding(
  songId: string,
  vec: number[],
  opts: { fileSize?: number | null; model?: string } = {},
): void {
  db.run(
    `INSERT INTO library_embeddings (song_id, model, dim, vec, file_size, updated_at)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [
      songId,
      opts.model ?? MODEL,
      vec.length,
      Buffer.from(new Float32Array(vec).buffer),
      opts.fileSize === undefined ? 1000 : opts.fileSize,
    ],
  );
}

describe('computeGenreCentroids', () => {
  it('writes one L2-normalised centroid per real genre name, keyed case-insensitively', () => {
    seedSong('s1', { genre: 'Tech House' });
    seedEmbedding('s1', [3, 0]);
    seedSong('s2', { genres: ['tech house', 'Electronic'] });
    seedEmbedding('s2', [0, 4]);
    seedSong('s3', { genre: 'Other' }); // junk: never a genre
    seedEmbedding('s3', [1, 1]);

    const res = computeGenreCentroids(db, { now: 123 });
    expect(res).toEqual({ model: MODEL, members: 2, genres: 2 });

    const all = listGenreCentroids(db);
    expect([...all.keys()].sort()).toEqual(['electronic', 'tech house']);
    const th = all.get('tech house')!;
    expect(th.members).toBe(2);
    expect(th.model).toBe(MODEL);
    // Unit members (1,0) and (0,1): mean (0.5,0.5), norm √0.5 → coherence, then normalised.
    expect(th.coherence).toBeCloseTo(Math.SQRT1_2, 5);
    expect(th.vec[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(th.vec[1]).toBeCloseTo(Math.SQRT1_2, 5);
    // Display spelling: the first one seen.
    expect(th.genre).toBe('Tech House');
    expect(all.get('electronic')!.members).toBe(1);
  });

  it('coherence is 1 when every member sounds alike and lower when they disagree', () => {
    seedSong('a1', { genre: 'Chacarera' });
    seedEmbedding('a1', [1, 0]);
    seedSong('a2', { genre: 'Chacarera' });
    seedEmbedding('a2', [2, 0]);
    seedSong('b1', { genre: 'Electronic' });
    seedEmbedding('b1', [1, 0]);
    seedSong('b2', { genre: 'Electronic' });
    seedEmbedding('b2', [-1, 0.01]);

    computeGenreCentroids(db);
    const all = listGenreCentroids(db);
    expect(all.get('chacarera')!.coherence).toBeCloseTo(1, 6);
    expect(all.get('electronic')!.coherence).toBeLessThan(0.1);
  });

  it('excludes hidden songs, hidden albums, stale vectors and other models', () => {
    seedSong('ok', { genre: 'Tango' });
    seedEmbedding('ok', [1, 0]);
    seedSong('hidden', { genre: 'Tango', hidden: 1 });
    seedEmbedding('hidden', [0, 1]);
    seedSong('hidden-album', { genre: 'Tango', albumId: 'al-hidden' });
    seedEmbedding('hidden-album', [0, 1]);
    seedSong('stale', { genre: 'Tango' });
    seedEmbedding('stale', [0, 1], { fileSize: 999 }); // file replaced in place (#258)
    seedSong('other-model', { genre: 'Tango' });
    seedEmbedding('other-model', [0, 1], { model: 'another' });

    const res = computeGenreCentroids(db);
    expect(res.members).toBe(1);
    const tango = listGenreCentroids(db).get('tango')!;
    expect(tango.members).toBe(1);
    expect(tango.vec[0]).toBeCloseTo(1, 6);
  });

  it('rebuilds from scratch — a genre that lost every member disappears', () => {
    seedSong('s1', { genre: 'Tango' });
    seedEmbedding('s1', [1, 0]);
    computeGenreCentroids(db);
    expect(countGenreCentroids(db)).toBe(1);

    db.run(`UPDATE library_songs SET genre = 'Milonga' WHERE id = 's1'`);
    computeGenreCentroids(db);
    expect([...listGenreCentroids(db).keys()]).toEqual(['milonga']);
  });

  it('empties the table when the library has no embeddings at all', () => {
    seedSong('s1', { genre: 'Tango' });
    expect(computeGenreCentroids(db)).toEqual({ model: null, members: 0, genres: 0 });
    expect(countGenreCentroids(db)).toBe(0);
  });
});

describe('loadGenreCentroids / loadGenreAffinity', () => {
  it('loads by any spelling and returns undefined when nothing matched', () => {
    seedSong('s1', { genre: 'Tech House' });
    seedEmbedding('s1', [1, 0]);
    computeGenreCentroids(db);

    const loaded = loadGenreCentroids(db, ['TECH  house', 'Tango']);
    expect([...loaded.keys()]).toEqual(['tech house']);
    expect(loadGenreAffinity(db, ['Tango'])).toBeUndefined();
    expect(loadGenreAffinity(db, ['tech house'])).toBeFunction();
  });

  it('the resolver scores an exact match on a stored genre by its coherence and unknown pairs as null', () => {
    for (let i = 0; i < 6; i++) {
      seedSong(`s${i}`, { genre: 'Tech House' });
      seedEmbedding(`s${i}`, [1, 0]);
    }
    computeGenreCentroids(db);
    const affinity = loadGenreAffinity(db, ['Tech House'])!;
    expect(affinity('Tech House', 'tech house')).toBe(1); // coherence 1 → full credit
    expect(affinity('Tech House', 'Tango')).toBeNull();
  });
});

describe('maybeRunDailyGenreCentroids', () => {
  it('builds on the first tick, then at most once per calendar day', () => {
    seedSong('s1', { genre: 'Tango' });
    seedEmbedding('s1', [1, 0]);
    const day1 = Date.UTC(2026, 8, 12, 6);

    expect(maybeRunDailyGenreCentroids(db, { now: day1 })).toBe(true);
    expect(countGenreCentroids(db)).toBe(1);

    seedSong('s2', { genre: 'Milonga' });
    seedEmbedding('s2', [0, 1]);
    expect(maybeRunDailyGenreCentroids(db, { now: day1 + 3_600_000 })).toBe(false);
    expect(countGenreCentroids(db)).toBe(1);

    expect(maybeRunDailyGenreCentroids(db, { now: day1 + 86_400_000 })).toBe(true);
    expect(countGenreCentroids(db)).toBe(2);
  });
});
