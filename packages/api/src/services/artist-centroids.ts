/**
 * Artist centroids — one audio summary per library artist: the AUDIO source of
 * related artists (docs/related-artists.md). `related-artists.ts` merges it with
 * any other source and ranks; this module only answers "who sounds alike".
 *
 * The same single fold as `genre-centroids.ts`, keyed by artist instead of
 * genre: each analysed track's L2-normalised embedding is added to every
 * PRIMARY artist it credits (a featured guest's verse must not pull the guest
 * toward the host's sound), and the norm of the mean is the members' mean
 * cosine to their centroid (`coherence`).
 *
 * Reads go through an in-memory index — one contiguous matrix of every
 * centroid at or above the member floor — reloaded when the table's build
 * stamp moves. 511 artists × 1280 dims measured 2.6 MB and ~4 ms per full scan
 * on prod (2026-10-06), so a request is a dot product per artist, no BLOBs.
 */

import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import { dominantEmbeddingModel } from './embedding-store.js';
import { decodeVec, encodeVec, normalise } from './embedding-vec.js';
import { feedEligibilitySql } from './recommendation/eligibility.js';

const log = createLogger('artist-centroids');

/**
 * Below this many analysed tracks a centroid is one or two songs, not an
 * artist. Prod: 2,332 artists have ≥ 1, 807 ≥ 2, 511 ≥ 3, 357 ≥ 5.
 */
export const MIN_ARTIST_MEMBERS = 3;

/**
 * A sanity floor, not the selector (that is the relative cut in `rankRelated`).
 * Kept low on purpose: a thin centroid's cosines all run ~0.2/n under its true
 * ones, so a higher absolute floor would empty a small artist's whole row.
 */
export const MIN_RELATED_COSINE = 0.7;

export interface ComputeArtistCentroidsResult {
  model: string | null;
  /** Analysed, eligible (song, primary artist) credits folded in. */
  members: number;
  /** Artist rows written (every artist with ≥ 1 member — the floor is applied at read time). */
  artists: number;
}

/**
 * Rebuild `library_artist_centroids` from scratch, atomically, in the
 * library's dominant embedding model. Eligibility and the content check are
 * exactly `computeGenreCentroids`' (hidden song/album out, a vector of a file
 * since replaced in place out).
 */
export function computeArtistCentroids(
  db: Database,
  opts: { model?: string | null; now?: number } = {},
): ComputeArtistCentroidsResult {
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
    db.run('DELETE FROM library_artist_centroids');
    return { model: null, members: 0, artists: 0 };
  }

  const eligible = feedEligibilitySql({ alias: 's', tier: 2 });
  const rows = db
    .query<{ artist_id: string; vec: Uint8Array }, [string]>(
      `SELECT sa.artist_id, e.vec
         FROM library_embeddings e
         JOIN library_songs s ON s.id = e.song_id
         JOIN library_song_artists sa ON sa.song_id = s.id AND sa.role = 'primary'
        WHERE e.model = ? AND e.orphaned_at IS NULL
          AND (e.file_size IS NULL OR e.file_size IS s.size)
          AND ${eligible}`,
    )
    .all(model);

  const sums = new Map<string, { sum: Float64Array; n: number }>();
  let dim = 0;
  let members = 0;
  for (const r of rows) {
    const v = decodeVec(r.vec);
    if (v.length === 0 || (dim && v.length !== dim) || !normalise(v)) continue;
    dim = v.length;
    members++;
    let acc = sums.get(r.artist_id);
    if (!acc) {
      acc = { sum: new Float64Array(dim), n: 0 };
      sums.set(r.artist_id, acc);
    }
    for (let i = 0; i < dim; i++) acc.sum[i]! += v[i]!;
    acc.n++;
  }

  const insert = db.prepare(
    `INSERT INTO library_artist_centroids
       (artist_id, model, dim, vec, members, coherence, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let artists = 0;
  db.transaction(() => {
    db.run('DELETE FROM library_artist_centroids');
    for (const [id, acc] of sums) {
      const mean = new Float32Array(dim);
      for (let i = 0; i < dim; i++) mean[i] = acc.sum[i]! / acc.n;
      let norm = 0;
      for (let i = 0; i < dim; i++) norm += mean[i]! * mean[i]!;
      const coherence = Math.sqrt(norm);
      if (!normalise(mean)) continue;
      insert.run(id, model, dim, encodeVec(mean), acc.n, coherence, now);
      artists++;
    }
  })();
  log.info({ model, members, artists }, 'artist centroids rebuilt');
  return { model, members, artists };
}

const DAY_MARKER = 'artist_centroids_last_day';

/**
 * Daily guard, safe to call every processor tick — the shape of
 * `maybeRunDailyGenreCentroids`. A fresh install builds on its first tick.
 * Never throws: housekeeping must not break the tick.
 */
export function maybeRunDailyArtistCentroids(db: Database, opts: { now?: number } = {}): boolean {
  const now = opts.now ?? Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const marker = db
    .query<{ value: string }, [string]>('SELECT value FROM library_sync_state WHERE key = ?')
    .get(DAY_MARKER);
  if (marker?.value === day) return false;
  try {
    computeArtistCentroids(db, { now });
    db.run(
      `INSERT INTO library_sync_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [DAY_MARKER, day, now],
    );
    return true;
  } catch (err) {
    log.error({ err }, 'daily artist-centroid rebuild failed');
    return false;
  }
}

interface ArtistIndex {
  stamp: string;
  dim: number;
  ids: string[];
  members: number[];
  coherence: number[];
  /** Row-major, one unit vector per artist. */
  mat: Float32Array;
}

const indexes = new WeakMap<Database, ArtistIndex>();

function buildStamp(db: Database): string {
  const row = db
    .query<{ n: number; at: number | null }, []>(
      'SELECT COUNT(*) AS n, MAX(computed_at) AS at FROM library_artist_centroids',
    )
    .get();
  return `${row?.at ?? 0}:${row?.n ?? 0}`;
}

function loadIndex(db: Database): ArtistIndex {
  const stamp = buildStamp(db);
  const cached = indexes.get(db);
  if (cached?.stamp === stamp) return cached;
  const rows = db
    .query<
      { artist_id: string; dim: number; vec: Uint8Array; members: number; coherence: number },
      [number]
    >(
      `SELECT artist_id, dim, vec, members, coherence FROM library_artist_centroids
        WHERE members >= ? ORDER BY artist_id`,
    )
    .all(MIN_ARTIST_MEMBERS);
  const dim = rows[0]?.dim ?? 0;
  const usable = rows.filter((r) => r.dim === dim);
  const mat = new Float32Array(usable.length * dim);
  usable.forEach((r, k) => mat.set(decodeVec(r.vec), k * dim));
  const index: ArtistIndex = {
    stamp,
    dim,
    ids: usable.map((r) => r.artist_id),
    members: usable.map((r) => r.members),
    coherence: usable.map((r) => r.coherence),
    mat,
  };
  indexes.set(db, index);
  return index;
}

/** One artist's audio neighbour, highest cosine first. */
export interface AudioNeighbour {
  id: string;
  cosine: number;
  /** Analysed primary tracks behind the neighbour's centroid. */
  members: number;
  /** Mean cosine of those tracks to their centroid: 1 = one consistent sound. */
  coherence: number;
}

/**
 * The `limit` closest centroids to `artistId`'s, or null when the artist has no
 * centroid at or above the member floor. No visibility filter — the caller
 * owns that, once, across every source.
 */
export function audioNeighbours(
  db: Database,
  artistId: string,
  limit: number,
): AudioNeighbour[] | null {
  const index = loadIndex(db);
  const seed = index.ids.indexOf(artistId);
  if (seed < 0) return null;
  const { dim, mat } = index;
  const qo = seed * dim;
  const sims: { k: number; cosine: number }[] = [];
  for (let k = 0; k < index.ids.length; k++) {
    if (k === seed) continue;
    const ko = k * dim;
    let d = 0;
    for (let i = 0; i < dim; i++) d += mat[qo + i]! * mat[ko + i]!;
    sims.push({ k, cosine: d });
  }
  sims.sort((a, b) => b.cosine - a.cosine);
  return sims.slice(0, limit).map(({ k, cosine }) => ({
    id: index.ids[k]!,
    cosine,
    members: index.members[k]!,
    coherence: index.coherence[k]!,
  }));
}
