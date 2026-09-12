/**
 * Genre centroids — one audio summary per genre NAME, learned from the
 * library's own discogs-effnet embeddings (docs/genre-affinity.md).
 *
 * The scorer-side consumer is `genre-affinity.ts` (pure); this module is the
 * IO half: the single pass that folds every analysed track's embedding into
 * the centroid of every genre it carries, the side table that caches the
 * result, the pooled loader radio reads, and the daily marker-guarded refresh
 * the processing scheduler ticks.
 *
 * One pass, no second read: each member vector is L2-normalised and added to
 * every genre it carries; centroid = sum / n, and the norm of that mean IS the
 * mean cosine of the members to their centroid (`coherence`), so the umbrella
 * signal is free. ~15k rows × 1280 floats stream through once (a background
 * sweep, never a request).
 */

import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import { dominantEmbeddingModel } from './embedding-store.js';
import { genreKey, isRealGenre } from './genre-split.js';
import { feedEligibilitySql } from './recommendation/eligibility.js';
import { makeGenreAffinity, type GenreAffinityFn, type GenreCentroid } from './genre-affinity.js';

const log = createLogger('genre-centroids');

interface MemberRow {
  song_id: string;
  vec: Uint8Array;
  genre: string | null;
  genres_all: string | null;
}

interface CentroidRow {
  genre_key: string;
  genre: string;
  model: string;
  dim: number;
  vec: Uint8Array;
  members: number;
  coherence: number;
}

/** Decode a stored BLOB back into a Float32Array (copy — the BLOB is a view). */
function decodeVec(vec: Uint8Array): Float32Array {
  const bytes = Uint8Array.from(vec);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

function encodeVec(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** In-place L2 normalisation; false when the vector is all zeros (unusable). */
function normalise(v: Float32Array): boolean {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  if (n === 0) return false;
  const inv = 1 / Math.sqrt(n);
  for (let i = 0; i < v.length; i++) v[i]! *= inv;
  return true;
}

/** The real (non-junk) genre set of one member row, keyed, display kept. */
function memberGenres(r: MemberRow): Map<string, string> {
  const out = new Map<string, string>();
  const all = [r.genre ?? '', ...(r.genres_all ? r.genres_all.split('; ') : [])];
  for (const g of all) {
    const t = g.trim();
    if (!t || !isRealGenre(t)) continue;
    const k = genreKey(t);
    if (!out.has(k)) out.set(k, t);
  }
  return out;
}

export interface ComputeGenreCentroidsResult {
  model: string | null;
  /** Analysed, eligible tracks folded in. */
  members: number;
  /** Genre names written (every real tag with ≥ 1 member — the floor is applied at read time). */
  genres: number;
}

/**
 * Rebuild `library_genre_centroids` from scratch, atomically. The vector space
 * is the library's dominant embedding model; rows under another model are
 * skipped (they cannot be averaged with it), same as the scorer does per pool.
 * Eligibility is the shared feed predicate (hidden song/album out) at tier 2 —
 * an embedded track is analysed by definition, and a bpm the analyser gave up
 * on must not drop a perfectly good vector.
 */
export function computeGenreCentroids(
  db: Database,
  opts: { model?: string | null; now?: number } = {},
): ComputeGenreCentroidsResult {
  const now = opts.now ?? Date.now();
  const model =
    opts.model ??
    dominantEmbeddingModel(
      db,
      db
        .query<{ song_id: string }, []>('SELECT DISTINCT song_id FROM library_embeddings')
        .all()
        .map((r) => r.song_id),
    );
  if (!model) {
    db.run('DELETE FROM library_genre_centroids');
    return { model: null, members: 0, genres: 0 };
  }

  const eligible = feedEligibilitySql({ alias: 's', tier: 2 });
  // Same content check as `loadEmbeddings` (issue #258): a file replaced in
  // place keeps its id, and a stale vector must not describe a genre.
  const rows = db
    .query<MemberRow, [string]>(
      `SELECT e.song_id, e.vec, s.genre,
              (SELECT GROUP_CONCAT(genre, '; ') FROM (
                 SELECT genre FROM library_song_genres WHERE song_id = s.id ORDER BY position
              )) AS genres_all
         FROM library_embeddings e
         JOIN library_songs s ON s.id = e.song_id
        WHERE e.model = ? AND e.orphaned_at IS NULL
          AND (e.file_size IS NULL OR e.file_size IS s.size)
          AND ${eligible}`,
    )
    .all(model);

  const sums = new Map<string, { genre: string; sum: Float64Array; n: number }>();
  let dim = 0;
  let members = 0;
  for (const r of rows) {
    const genres = memberGenres(r);
    if (genres.size === 0) continue;
    const v = decodeVec(r.vec);
    if (v.length === 0 || (dim && v.length !== dim) || !normalise(v)) continue;
    dim = v.length;
    members++;
    for (const [k, display] of genres) {
      let acc = sums.get(k);
      if (!acc) {
        acc = { genre: display, sum: new Float64Array(dim), n: 0 };
        sums.set(k, acc);
      }
      for (let i = 0; i < dim; i++) acc.sum[i]! += v[i]!;
      acc.n++;
    }
  }

  const insert = db.prepare(
    `INSERT INTO library_genre_centroids
       (genre_key, genre, model, dim, vec, members, coherence, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const write = db.transaction(() => {
    db.run('DELETE FROM library_genre_centroids');
    for (const [k, acc] of sums) {
      const mean = new Float32Array(dim);
      for (let i = 0; i < dim; i++) mean[i] = acc.sum[i]! / acc.n;
      // |mean of unit vectors| = mean cosine of members to the centroid.
      let norm = 0;
      for (let i = 0; i < dim; i++) norm += mean[i]! * mean[i]!;
      const coherence = Math.sqrt(norm);
      if (!normalise(mean)) continue;
      insert.run(k, acc.genre, model, dim, encodeVec(mean), acc.n, coherence, now);
    }
  });
  write();
  const genres = sums.size;
  log.info({ model, members, genres }, 'genre centroids rebuilt');
  return { model, members, genres };
}

/**
 * Load centroids for the given genre names (any spelling; keyed by `genreKey`).
 * Chunked so the `IN (...)` list stays well under SQLite's variable limit.
 */
export function loadGenreCentroids(
  db: Database,
  genres: Iterable<string>,
): Map<string, GenreCentroid> {
  const keys = [...new Set([...genres].map(genreKey).filter(Boolean))];
  const out = new Map<string, GenreCentroid>();
  const CHUNK = 500;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .query<CentroidRow, string[]>(
        `SELECT genre_key, genre, model, dim, vec, members, coherence
           FROM library_genre_centroids WHERE genre_key IN (${placeholders})`,
      )
      .all(...chunk);
    for (const r of rows) {
      out.set(r.genre_key, {
        genre: r.genre,
        model: r.model,
        vec: decodeVec(r.vec),
        members: r.members,
        coherence: r.coherence,
      });
    }
  }
  return out;
}

/** Every stored centroid — the diagnostic script's vocabulary. */
export function listGenreCentroids(db: Database): Map<string, GenreCentroid> {
  const rows = db
    .query<CentroidRow, []>(
      `SELECT genre_key, genre, model, dim, vec, members, coherence
         FROM library_genre_centroids ORDER BY members DESC, genre`,
    )
    .all();
  const out = new Map<string, GenreCentroid>();
  for (const r of rows) {
    out.set(r.genre_key, {
      genre: r.genre,
      model: r.model,
      vec: decodeVec(r.vec),
      members: r.members,
      coherence: r.coherence,
    });
  }
  return out;
}

/**
 * The scorer-facing resolver for one request: centroids for exactly the
 * genres in play (seed + pool), or `undefined` when none is stored — callers
 * then pass nothing and the genre axis stays lexical.
 */
export function loadGenreAffinity(
  db: Database,
  genres: Iterable<string>,
): GenreAffinityFn | undefined {
  const centroids = loadGenreCentroids(db, genres);
  return centroids.size > 0 ? makeGenreAffinity(centroids) : undefined;
}

export function countGenreCentroids(db: Database): number {
  return Number(
    db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM library_genre_centroids').get()?.n ?? 0,
  );
}

/** What the settings UI shows next to the opt-in: how much data backs it. */
export function genreCentroidsStatus(db: Database): {
  centroids: number;
  computedAt: number | null;
} {
  const row = db
    .query<{ n: number; at: number | null }, []>(
      'SELECT COUNT(*) AS n, MAX(computed_at) AS at FROM library_genre_centroids',
    )
    .get();
  return { centroids: Number(row?.n ?? 0), computedAt: row?.at ?? null };
}

const DAY_MARKER = 'genre_centroids_last_day';

function readMarker(db: Database, key: string): string | null {
  const row = db
    .query<{ value: string }, [string]>('SELECT value FROM library_sync_state WHERE key = ?')
    .get(key);
  return row?.value ?? null;
}

function writeMarker(db: Database, key: string, value: string, now: number): void {
  db.run(
    `INSERT INTO library_sync_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, now],
  );
}

/**
 * Daily guard, safe to call every processor tick — the same marker-guarded
 * shape as `maybeRunDailyOrphanPrune`. Runs at most one rebuild per calendar
 * day; a fresh install has no marker, so its first tick builds the table
 * rather than waiting a day. Never throws: housekeeping must not break the
 * tick. Returns true when a rebuild ran.
 */
export function maybeRunDailyGenreCentroids(db: Database, opts: { now?: number } = {}): boolean {
  const now = opts.now ?? Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  if (readMarker(db, DAY_MARKER) === day) return false;
  try {
    computeGenreCentroids(db, { now });
    writeMarker(db, DAY_MARKER, day, now);
    return true;
  } catch (err) {
    log.error({ err }, 'daily genre-centroid rebuild failed');
    return false;
  }
}
