import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  audioNeighbours,
  computeArtistCentroids,
  maybeRunDailyArtistCentroids,
  MIN_ARTIST_MEMBERS,
} from './artist-centroids.js';

const MODEL = 'discogs-effnet-bs64-1';

let db: Database;
let songSeq = 0;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  songSeq = 0;
});

function seedArtist(id: string): void {
  db.run(`INSERT INTO library_artists (id, name, synced_at) VALUES (?, ?, 1)`, [id, id]);
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
     VALUES (?, 'Album', ?, ?, 1, 0, 1)`,
    [`al-${id}`, id, id],
  );
}

/** One analysed track credited to `primary` (and optionally a featured guest). */
function seedTrack(
  primary: string | string[],
  vec: number[],
  opts: { featuring?: string; fileSize?: number; hidden?: number; model?: string } = {},
): string {
  const artists = Array.isArray(primary) ? primary : [primary];
  const id = `s${++songSeq}`;
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, hidden, created, synced_at)
     VALUES (?, ?, ?, ?, ?, 200, ?, 1000, ?, '2024-01-01', 1)`,
    [id, `al-${artists[0]}`, id, artists[0]!, artists[0]!, `${id}.opus`, opts.hidden ?? 0],
  );
  artists.forEach((a, i) =>
    db.run(
      `INSERT INTO library_song_artists (song_id, artist_id, role, position) VALUES (?, ?, 'primary', ?)`,
      [id, a, i],
    ),
  );
  if (opts.featuring) {
    db.run(
      `INSERT INTO library_song_artists (song_id, artist_id, role, position) VALUES (?, ?, 'featuring', 9)`,
      [id, opts.featuring],
    );
  }
  db.run(
    `INSERT INTO library_embeddings (song_id, model, dim, vec, file_size, updated_at)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [
      id,
      opts.model ?? MODEL,
      vec.length,
      Buffer.from(new Float32Array(vec).buffer),
      opts.fileSize ?? 1000,
    ],
  );
  return id;
}

/** An artist with `MIN_ARTIST_MEMBERS` tracks, all pointing at `vec`. */
function seedAnalysedArtist(id: string, vec: number[]): void {
  seedArtist(id);
  for (let i = 0; i < MIN_ARTIST_MEMBERS; i++) seedTrack(id, vec);
}

function centroid(id: string) {
  return db
    .query<{ members: number; coherence: number; vec: Uint8Array; computed_at: number }, [string]>(
      'SELECT members, coherence, vec, computed_at FROM library_artist_centroids WHERE artist_id = ?',
    )
    .get(id);
}

describe('computeArtistCentroids', () => {
  it('folds unit vectors into one normalised centroid per primary artist', () => {
    seedArtist('a');
    seedTrack('a', [3, 0]);
    seedTrack('a', [0, 4]);

    expect(computeArtistCentroids(db, { now: 7 })).toEqual({
      model: MODEL,
      members: 2,
      artists: 1,
    });
    const c = centroid('a')!;
    expect(c.members).toBe(2);
    expect(c.computed_at).toBe(7);
    // Unit (1,0) and (0,1): mean norm √0.5 is the coherence; the stored vector is unit.
    expect(c.coherence).toBeCloseTo(Math.SQRT1_2, 5);
    const v = new Float32Array(Uint8Array.from(c.vec).buffer);
    expect(v[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(v[1]).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it('credits every primary artist of a shared track, never a featured guest', () => {
    seedArtist('a');
    seedArtist('b');
    seedArtist('guest');
    seedTrack(['a', 'b'], [1, 0], { featuring: 'guest' });

    computeArtistCentroids(db);
    expect(centroid('a')!.members).toBe(1);
    expect(centroid('b')!.members).toBe(1);
    expect(centroid('guest')).toBeNull();
  });

  it('excludes hidden songs, stale vectors and other models', () => {
    seedArtist('a');
    seedTrack('a', [1, 0]);
    seedTrack('a', [0, 1], { hidden: 1 });
    seedTrack('a', [0, 1], { fileSize: 999 }); // file replaced in place since analysis
    seedTrack('a', [0, 1], { model: 'other-model' });

    computeArtistCentroids(db, { model: MODEL });
    expect(centroid('a')!.members).toBe(1);
  });

  it('rebuilds from scratch: an artist with no analysed track left drops out', () => {
    seedArtist('a');
    const s = seedTrack('a', [1, 0]);
    computeArtistCentroids(db);
    expect(centroid('a')).not.toBeNull();

    db.run('DELETE FROM library_embeddings WHERE song_id = ?', [s]);
    expect(computeArtistCentroids(db).model).toBeNull();
    expect(centroid('a')).toBeNull();
  });
});

describe('maybeRunDailyArtistCentroids', () => {
  it('builds once per calendar day', () => {
    seedArtist('a');
    seedTrack('a', [1, 0]);
    const day = Date.parse('2026-10-06T10:00:00Z');
    expect(maybeRunDailyArtistCentroids(db, { now: day })).toBe(true);
    expect(maybeRunDailyArtistCentroids(db, { now: day + 3_600_000 })).toBe(false);
    expect(maybeRunDailyArtistCentroids(db, { now: day + 86_400_000 })).toBe(true);
  });
});

describe('audioNeighbours', () => {
  it('orders by cosine, excludes the seed, and honours the limit', () => {
    seedAnalysedArtist('seed', [1, 0]);
    seedAnalysedArtist('close', [1, 0.1]);
    seedAnalysedArtist('mid', [1, 1]);
    seedAnalysedArtist('far', [0, 1]);
    computeArtistCentroids(db);

    const all = audioNeighbours(db, 'seed', 10)!;
    expect(all.map((n) => n.id)).toEqual(['close', 'mid', 'far']);
    expect(all[0]!.cosine).toBeGreaterThan(all[1]!.cosine);
    expect(all[0]!.members).toBe(MIN_ARTIST_MEMBERS);
    expect(all[0]!.coherence).toBeCloseTo(1, 5);
    expect(audioNeighbours(db, 'seed', 1)!.map((n) => n.id)).toEqual(['close']);
  });

  it('has no answer for an artist below the member floor, and never offers one', () => {
    seedAnalysedArtist('seed', [1, 0]);
    seedArtist('thin');
    for (let i = 0; i < MIN_ARTIST_MEMBERS - 1; i++) seedTrack('thin', [1, 0]);
    computeArtistCentroids(db);

    expect(audioNeighbours(db, 'thin', 10)).toBeNull();
    expect(audioNeighbours(db, 'seed', 10)).toEqual([]);
  });

  it('picks up a rebuild without a restart', () => {
    seedAnalysedArtist('seed', [1, 0]);
    seedAnalysedArtist('x', [1, 0.2]);
    computeArtistCentroids(db, { now: 1 });
    expect(audioNeighbours(db, 'seed', 10)!.map((n) => n.id)).toEqual(['x']);

    seedAnalysedArtist('y', [1, 0.05]);
    computeArtistCentroids(db, { now: 2 });
    expect(audioNeighbours(db, 'seed', 10)!.map((n) => n.id)).toEqual(['y', 'x']);
  });
});
