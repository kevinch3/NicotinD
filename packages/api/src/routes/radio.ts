import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { parseLibraryFilter, type LibraryFilter, type Song } from '@nicotind/core';
import { getDatabase } from '../db.js';
import {
  rankCandidates,
  recentPlayFactor,
  type ScoredSong,
  type ScoringWeights,
  type SongFeatures,
} from '../services/radio.service.js';
import {
  dominantEmbeddingModel,
  embeddingModelFor,
  loadEmbeddings,
} from '../services/embedding-store.js';
import { artistGenreShares } from '../services/genre-distribution.js';
import { anchorCentroid, genreDepthScore, stationAffinity } from '../services/station-affinity.js';
import { lastPlayedAtMap } from '../services/play-history.js';
import { songFilterWheres } from '../services/library-filter-sql.js';
import { seedCentroid, type OrderableRow } from '../services/playlist-recipe.js';
import { isRealGenre } from '../services/genre-split.js';
import { loadDescriptors, type DescriptorFeatures } from '../services/descriptor-store.js';
import { descriptorBlocks, meanBlock, type DescriptorBlocks } from '../services/descriptor-axes.js';

/**
 * Descriptor blocks for one song (formula v5, issue #642), attached the way
 * embeddings are — after the pool is built, never through `RADIO_SONG_SELECT`
 * / `toOrderable`: the side table is what spares every new axis the 13-step
 * column checklist. A song with no row gets no blocks and skips the axes.
 */
function blocksFor(descriptors: Map<string, DescriptorFeatures>, id: string): DescriptorBlocks {
  const f = descriptors.get(id);
  return f ? descriptorBlocks(f) : {};
}

/** The station/list "seed" for the descriptor axes: the centroid of the members that carry blocks. */
function centroidBlocks(members: readonly DescriptorBlocks[]): DescriptorBlocks {
  return {
    timbre: meanBlock(members.map((m) => m.timbre)),
    groove: meanBlock(members.map((m) => m.groove)),
    bands: meanBlock(members.map((m) => m.bands)),
  };
}

/**
 * Pool floor: tracks under this length are never radio candidates - intros,
 * skits, "Commercial Break" teasers and (issue #583) 46 s language lessons
 * reached real queues, and duration closeness alone can't keep them out.
 * Env-overridable the same way as the e2e landing-gate bypass, because the
 * committed silent-FLAC e2e fixtures are ~30 s.
 */
export function minCandidateDurationSec(): number {
  const v = Number(process.env.NICOTIND_RADIO_MIN_DURATION);
  return Number.isFinite(v) && v >= 0 ? v : 60;
}

/** Longest alphanumeric token in a genre string, for the LIKE-widened pool.
 *  Returns null for genres whose longest token is too short to be selective. */
export function longestGenreToken(genre: string | undefined): string | null {
  if (!genre) return null;
  const tokens = genre
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4);
  if (tokens.length === 0) return null;
  return tokens.reduce((a, b) => (b.length > a.length ? b : a));
}

export interface RadioSongRow {
  id: string;
  album_id: string;
  album_name: string;
  album_cover_art: string | null;
  title: string;
  artist: string;
  artist_id: string;
  track: number | null;
  duration: number;
  year: number | null;
  genre: string | null;
  cover_art: string | null;
  path: string;
  size: number | null;
  bit_rate: number | null;
  suffix: string | null;
  content_type: string | null;
  created: string | null;
  starred: string | null;
  bpm: number | null;
  key: string | null;
  energy: number | null;
  loudness: number | null;
  valence: number | null;
  danceability: number | null;
  acousticness: number | null;
  instrumental: number | null;
  mood: string | null;
  genres_all: string | null;
  origin_countries: string | null;
}

export const RADIO_SONG_SELECT = `
  SELECT s.id, s.album_id, a.name AS album_name, a.cover_art AS album_cover_art,
         s.title, s.artist, s.artist_id, s.track, s.duration, s.year, s.genre,
         s.cover_art, s.path, s.size, s.bit_rate, s.suffix, s.content_type,
         s.created, s.starred, s.bpm, s.key,
         s.energy, s.loudness, s.valence, s.danceability, s.acousticness,
         s.instrumental, s.mood,
         (SELECT GROUP_CONCAT(genre, '; ') FROM (
            SELECT genre FROM library_song_genres WHERE song_id = s.id ORDER BY position
          )) AS genres_all,
         (SELECT GROUP_CONCAT(DISTINCT o.country) FROM library_artist_origins o
          WHERE o.country IS NOT NULL AND o.artist_id IN (
            SELECT artist_id FROM library_song_artists WHERE song_id = s.id
            UNION SELECT s.artist_id)) AS origin_countries
  FROM library_songs s
  LEFT JOIN library_albums a ON a.id = s.album_id
`;

/** Full genre set from the aggregated join-table column (primary-first). */
export function genresOf(r: RadioSongRow): string[] | undefined {
  if (r.genres_all) return r.genres_all.split('; ');
  return r.genre ? [r.genre] : undefined;
}

/** Credited-artist origin set from the aggregated column. */
export function originCountriesOf(r: RadioSongRow): string[] | undefined {
  return r.origin_countries ? r.origin_countries.split(',') : undefined;
}

export function rowToSong(r: RadioSongRow): Song & SongFeatures {
  return {
    id: r.id,
    title: r.title,
    album: r.album_name ?? '',
    albumId: r.album_id,
    artist: r.artist,
    artistId: r.artist_id,
    track: r.track ?? undefined,
    year: r.year ?? undefined,
    genre: r.genre ?? undefined,
    genres: genresOf(r),
    coverArt: r.cover_art ?? r.album_cover_art ?? r.album_id,
    size: r.size ?? 0,
    contentType: r.content_type ?? '',
    suffix: r.suffix ?? '',
    duration: r.duration,
    bitRate: r.bit_rate ?? 0,
    path: r.path,
    created: r.created ?? '',
    starred: r.starred ?? undefined,
    bpm: r.bpm ?? undefined,
    key: r.key ?? undefined,
    energy: r.energy ?? undefined,
    loudness: r.loudness ?? undefined,
    valence: r.valence ?? undefined,
    danceability: r.danceability ?? undefined,
    acousticness: r.acousticness ?? undefined,
    instrumental: r.instrumental ?? undefined,
    mood: r.mood ?? undefined,
  };
}

export function toFeatures(r: RadioSongRow): SongFeatures {
  return {
    bpm: r.bpm ?? undefined,
    key: r.key ?? undefined,
    genre: r.genre ?? undefined,
    genres: genresOf(r),
    originCountries: originCountriesOf(r),
    duration: r.duration,
    year: r.year ?? undefined,
    artistId: r.artist_id,
    energy: r.energy ?? undefined,
    valence: r.valence ?? undefined,
    danceability: r.danceability ?? undefined,
    instrumental: r.instrumental ?? undefined,
    acousticness: r.acousticness ?? undefined,
  };
}

/** RadioSongRow → the row shape the ordering/centroid helpers consume. */
export function toOrderable(r: RadioSongRow): OrderableRow {
  return {
    id: r.id,
    artist: r.artist,
    artistId: r.artist_id,
    bpm: r.bpm ?? undefined,
    key: r.key ?? undefined,
    // Issue #187 B4: this was missing entirely, so seedCentroid's mode() over
    // an all-undefined array always came back genre-less — filter radio's
    // centroid skipped the genre axis for every candidate, not just weighted
    // it low.
    genre: r.genre ?? undefined,
    genres: genresOf(r),
    // Same lesson as the genre line above: a column omitted here never reaches
    // seedCentroid and the axis silently dies for filter radio.
    originCountries: originCountriesOf(r),
    year: r.year ?? undefined,
    duration: r.duration,
    energy: r.energy ?? undefined,
    valence: r.valence ?? undefined,
    danceability: r.danceability ?? undefined,
    instrumental: r.instrumental ?? undefined,
    acousticness: r.acousticness ?? undefined,
    addedAt: r.created ? Date.parse(r.created) : undefined,
  };
}

/** A ranked candidate carrying its source row so callers can map back to a
 *  full Song (route) or re-run the score breakdown against it (dump). */
export type RadioCandidate = SongFeatures & { _row: RadioSongRow; embedding?: Float32Array };

export interface RadioResult {
  /** The scoring seed: a real song's features (seed radio) or the pool centroid
   *  (filter radio). Null when a filter matched nothing / had no centroid. */
  seed: SongFeatures | null;
  /** Every candidate considered (post-exclusion, pre-ranking). */
  pool: RadioCandidate[];
  /** The top-N after scoring + per-artist diversification. */
  ranked: ScoredSong<RadioCandidate>[];
}

/** Extract the ranked candidates as full Song rows (the route's response shape). */
export function radioSongs(result: RadioResult): Song[] {
  return result.ranked.map((e) => rowToSong(e.song._row));
}

/** The seed-derived knobs the candidate pool is built from — a real seed
 *  song's features (seed radio) or a seed *list*'s centroid (list radio). */
interface PoolSeed {
  /** Real (non-junk) genres for the any-genre pool. */
  genres: string[];
  /** Longest selective token of the primary genre, for the LIKE-widened pool. */
  genreToken: string | null;
  bpm?: number;
  energy?: number;
}

/**
 * Candidate pool construction (Pools 1–5), shared by seed radio and
 * list-seeded radio so the two lanes can't drift. `excludeIds` never enter the
 * pool; the caller owns putting the seed(s) in there.
 */
function collectPoolRows(
  db: ReturnType<typeof getDatabase>,
  feat: PoolSeed,
  excludeIds: ReadonlySet<string>,
): RadioSongRow[] {
  const durGate = minCandidateDurationSec();
  const candidates: RadioSongRow[] = [];
  const seen = new Set<string>(excludeIds);
  const addRows = (rows: RadioSongRow[]): void => {
    for (const r of rows) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        candidates.push(r);
      }
    }
  };

  // Pool 1: shares ANY genre with the seed's full set (up to 150) — the
  // join-table EXISTS means a track whose 3rd genre matches the seed's 2nd
  // is pooled just like a primary-genre match.
  // Junk genres ("Other", ...) are matching noise, not identity - a junk seed
  // genre would drag every same-junk row into the pool (issue #583).
  const seedGenres = feat.genres;
  if (seedGenres.length > 0) {
    const marks = seedGenres.map(() => '?').join(', ');
    addRows(
      db
        .query<RadioSongRow, string[]>(
          `${RADIO_SONG_SELECT}
           WHERE (s.genre IN (${marks}) OR EXISTS (
             SELECT 1 FROM library_song_genres g WHERE g.song_id = s.id AND g.genre IN (${marks})
           )) AND s.hidden = 0 AND s.landed_at IS NOT NULL AND s.duration >= ${durGate} ORDER BY RANDOM() LIMIT 150`,
        )
        .all(...seedGenres, ...seedGenres),
    );
  }

  // Pool 1b: genre-variant match via the seed's longest token (e.g. seed
  // "Deep House" also pulls "House"/"Tech House"), so lexical genre closeness
  // has variants to score instead of only exact-string matches.
  const genreToken = feat.genreToken;
  if (genreToken) {
    addRows(
      db
        .query<RadioSongRow, [string]>(
          `${RADIO_SONG_SELECT} WHERE LOWER(s.genre) LIKE '%' || ? || '%' AND s.hidden = 0 AND s.landed_at IS NOT NULL AND s.duration >= ${durGate}
           ORDER BY RANDOM() LIMIT 100`,
        )
        .all(genreToken),
    );
  }

  // Pool 2: similar BPM range across genres (± 15%), up to 100
  if (feat.bpm) {
    const bpmLow = Math.round(feat.bpm * 0.85);
    const bpmHigh = Math.round(feat.bpm * 1.15);
    addRows(
      db
        .query<RadioSongRow, [number, number]>(
          `${RADIO_SONG_SELECT} WHERE s.bpm BETWEEN ? AND ? AND s.hidden = 0 AND s.landed_at IS NOT NULL AND s.duration >= ${durGate}
           ORDER BY RANDOM() LIMIT 100`,
        )
        .all(bpmLow, bpmHigh),
    );
  }

  // Pool 3: energy-adjacent across genres (±0.15), up to 100 — keeps the
  // set's momentum coherent once the library carries energy values.
  if (feat.energy !== undefined) {
    addRows(
      db
        .query<RadioSongRow, [number, number]>(
          `${RADIO_SONG_SELECT} WHERE s.energy BETWEEN ? AND ? AND s.hidden = 0 AND s.landed_at IS NOT NULL AND s.duration >= ${durGate}
           ORDER BY RANDOM() LIMIT 100`,
        )
        .all(Math.max(0, feat.energy - 0.15), Math.min(1, feat.energy + 0.15)),
    );
  }

  // Pool 4: un-analyzed tracks (no bpm/energy) get a guaranteed seat so a
  // mid-backfill library stays discoverable and radio doesn't tunnel on the
  // already-analyzed slice.
  addRows(
    db
      .query<RadioSongRow, []>(
        `${RADIO_SONG_SELECT} WHERE (s.bpm IS NULL OR s.energy IS NULL) AND s.hidden = 0 AND s.landed_at IS NOT NULL AND s.duration >= ${durGate}
         ORDER BY RANDOM() LIMIT 30`,
      )
      .all(),
  );

  // Pool 5: random backfill if we still don't have enough candidates
  if (candidates.length < 50) {
    addRows(
      db
        .query<RadioSongRow, []>(
          `${RADIO_SONG_SELECT} WHERE s.hidden = 0 AND s.landed_at IS NOT NULL AND s.duration >= ${durGate} ORDER BY RANDOM() LIMIT 100`,
        )
        .all(),
    );
  }

  return candidates;
}

/**
 * Seed radio: build the candidate pool (Pools 1–5) around a seed song, attach
 * cached embeddings, and rank. Extracted from the route so the diagnostic dump
 * (`dump-radio.ts`) runs the exact same generation the live `/next` serves —
 * one implementation, no drift.
 */
export function buildSeedRadio(
  db: ReturnType<typeof getDatabase>,
  seedRow: RadioSongRow,
  opts: {
    count?: number;
    excludeIds?: Set<string>;
    weights?: ScoringWeights;
    /** Whose listening history demotes recently-played candidates. */
    userId?: string;
    now?: number;
  } = {},
): RadioResult {
  const count = opts.count ?? 10;
  const excludeIds = new Set(opts.excludeIds ?? []);
  excludeIds.add(seedRow.id);

  const seed = toFeatures(seedRow);
  const candidates = collectPoolRows(
    db,
    {
      genres: (seed.genres ?? (seed.genre ? [seed.genre] : [])).filter(isRealGenre),
      genreToken: seed.genre && isRealGenre(seed.genre) ? longestGenreToken(seed.genre) : null,
      bpm: seed.bpm,
      energy: seed.energy,
    },
    excludeIds,
  );

  // Attach cached embeddings (seed + pool) so the scorer can add the cosine
  // axis. No-op when the seed has no embedding (comparison needs both sides).
  const model = embeddingModelFor(db, seedRow.id);
  const embeddings = model
    ? loadEmbeddings(db, [seedRow.id, ...candidates.map((r) => r.id)], model)
    : new Map<string, Float32Array>();
  seed.embedding = embeddings.get(seedRow.id);
  const descriptors = loadDescriptors(db, [seedRow.id, ...candidates.map((r) => r.id)]);
  Object.assign(seed, blocksFor(descriptors, seedRow.id));

  const pool: RadioCandidate[] = attachRecency(
    db,
    candidates.map((r) => ({
      ...toFeatures(r),
      embedding: embeddings.get(r.id),
      ...blocksFor(descriptors, r.id),
      _row: r,
    })),
    opts.userId,
    opts.now,
  );
  const ranked = rankCandidates(seed, pool, { count, maxPerArtist: 2, weights: opts.weights });
  return { seed, pool, ranked };
}

/**
 * Plain mean of a seed list's embedding vectors (same-dimension only).
 * Deliberately NOT `anchorCentroid`: that trims to the highest-affinity
 * fraction of a *pool*, which is meaningless for an explicit seed list — every
 * seed was really listened to, so every seed counts equally.
 */
function meanEmbedding(vectors: readonly (Float32Array | undefined)[]): Float32Array | null {
  const withVec = vectors.filter((v): v is Float32Array => !!v?.length);
  if (withVec.length === 0) return null;
  const dim = withVec[0]!.length;
  const sameDim = withVec.filter((v) => v.length === dim);
  const out = new Float32Array(dim);
  for (const v of sameDim) for (let i = 0; i < dim; i++) out[i]! += v[i]!;
  for (let i = 0; i < dim; i++) out[i]! /= sameDim.length;
  return out;
}

/**
 * List-seeded radio ("keep the vibe", backing the landing shelf): ONE
 * generation seeded by a whole set of songs — scored against their centroid,
 * the same way filter radio scores against its pool centroid. Deliberately one
 * pool + one ranking rather than N per-seed radios: the recently-played list
 * is near-homogeneous in practice, so N× `buildSeedRadio` would run N× the
 * pool queries for near-identical pools and near-identical picks.
 *
 * Every seed is excluded from the results (a "variation of X" must never be X
 * itself), and the caller's recency demotion applies on top, so the shelf
 * leans away from everything the listener just heard, not only the seeds.
 */
export function buildListRadio(
  db: ReturnType<typeof getDatabase>,
  seedRows: RadioSongRow[],
  opts: {
    count?: number;
    excludeIds?: Set<string>;
    weights?: ScoringWeights;
    /** Whose listening history demotes recently-played candidates. */
    userId?: string;
    now?: number;
  } = {},
): RadioResult {
  const count = opts.count ?? 10;
  const excludeIds = new Set(opts.excludeIds ?? []);
  for (const r of seedRows) excludeIds.add(r.id);

  const seed = seedCentroid(seedRows.map(toOrderable));
  if (!seed) return { seed: null, pool: [], ranked: [] };

  // The list's full real-genre *union* drives both pooling and the genre-set
  // closeness axis — the centroid's modal primary alone would collapse a
  // mixed-but-coherent list onto one tag (the umbrella-tag lesson from
  // filter radio's centroid, docs/radio.md "Stations").
  const genreUnion = [...new Set(seedRows.flatMap((r) => genresOf(r) ?? []).filter(isRealGenre))];
  if (genreUnion.length) seed.genres = genreUnion;

  const candidates = collectPoolRows(
    db,
    {
      genres: genreUnion,
      genreToken: seed.genre && isRealGenre(seed.genre) ? longestGenreToken(seed.genre) : null,
      bpm: seed.bpm,
      energy: seed.energy,
    },
    excludeIds,
  );

  // Audio axis: anchor on the seeds' mean vector under the seed set's dominant
  // model (mixed-model libraries mid-migration pick the majority side).
  const seedIds = seedRows.map((r) => r.id);
  const model = dominantEmbeddingModel(db, seedIds);
  const embeddings = loadEmbeddings(db, [...seedIds, ...candidates.map((r) => r.id)], model);
  seed.embedding = meanEmbedding(seedIds.map((id) => embeddings.get(id))) ?? undefined;
  const descriptors = loadDescriptors(db, [...seedIds, ...candidates.map((r) => r.id)]);
  Object.assign(seed, centroidBlocks(seedIds.map((id) => blocksFor(descriptors, id))));

  const pool: RadioCandidate[] = attachRecency(
    db,
    candidates.map((r) => ({
      ...toFeatures(r),
      embedding: embeddings.get(r.id),
      ...blocksFor(descriptors, r.id),
      _row: r,
    })),
    opts.userId,
    opts.now,
  );
  const ranked = rankCandidates(seed, pool, { count, maxPerArtist: 2, weights: opts.weights });
  return { seed, pool, ranked };
}

/**
 * Attach each candidate's "how recently did *this listener* play it" factor, so
 * the scorer can demote a track you just heard (see radio.service
 * `recentPlayFactor`). No `userId` — e.g. the dev diagnostic dump — means no
 * demotion at all rather than a wrong one.
 *
 * `now` is threaded rather than read inside the scorer so that module stays
 * pure and its decay is testable without a clock.
 */
function attachRecency<T extends SongFeatures & { _row: RadioSongRow }>(
  db: ReturnType<typeof getDatabase>,
  pool: T[],
  userId: string | undefined,
  now: number = Date.now(),
): T[] {
  if (!userId || pool.length === 0) return pool;
  const lastPlayed = lastPlayedAtMap(
    db,
    userId,
    pool.map((p) => p._row.id),
  );
  for (const p of pool) {
    p.recentPlayFactor = recentPlayFactor(lastPlayed.get(p._row.id), now);
  }
  return pool;
}

/**
 * Filter-seeded radio: instead of a single seed song, the pool IS the set of
 * songs matching a `LibraryFilter` (e.g. "happy rock", "120bpm+ danceable"),
 * and the seed is that set's centroid — so ranking keeps the vibe coherent
 * while `maxPerArtist` diversifies. Reuses the same scorer as seed radio.
 * Returns an empty result when nothing matches / no centroid.
 */
export function buildFilterRadio(
  db: ReturnType<typeof getDatabase>,
  filter: LibraryFilter,
  opts: {
    count?: number;
    excludeIds?: Set<string>;
    weights?: ScoringWeights;
    /** Whose listening history demotes recently-played candidates. */
    userId?: string;
    now?: number;
  } = {},
): RadioResult {
  const count = opts.count ?? 10;
  const excludeIds = new Set(opts.excludeIds ?? []);
  const durGate = minCandidateDurationSec();
  const { wheres, params } = songFilterWheres(filter, 's');
  const filterSql = wheres.length ? `${wheres.join(' AND ')} AND ` : '';
  const rows = db
    .query<RadioSongRow, (string | number)[]>(
      `${RADIO_SONG_SELECT} WHERE ${filterSql} s.hidden = 0 AND s.landed_at IS NOT NULL AND s.duration >= ${durGate}
       ORDER BY RANDOM() LIMIT 300`,
    )
    .all(...params);

  const poolRows = rows.filter((r) => !excludeIds.has(r.id));

  // The station's genres, junk dropped ("Other" is a tagger's shrug, not a
  // station). Empty for a pure mood/bpm vibe, which keeps the plain genre axis.
  const stationGenres = (filter.genres ?? []).filter((g) => g && isRealGenre(g));

  // One batched query for the whole pool's artists — `artistGenreDistribution`
  // per candidate would be 300 round trips to compute one number each.
  const shares = stationGenres.length
    ? artistGenreShares(
        db,
        poolRows.map((r) => r.artist_id),
        stationGenres,
      )
    : new Map<string, number>();

  const pool: RadioCandidate[] = attachRecency(
    db,
    poolRows.map((r) => {
      const features = toFeatures(r);
      if (stationGenres.length) {
        // Graded membership replaces the (degenerate) genre axis — see
        // services/station-affinity.ts for why boolean membership left the
        // heaviest weight in the blend ordering nothing.
        features.stationAffinity = stationAffinity(
          genreDepthScore(genresOf(r), stationGenres),
          shares.get(r.artist_id),
        );
      }
      return { ...features, _row: r };
    }),
    opts.userId,
    opts.now,
  );
  if (pool.length === 0) return { seed: null, pool, ranked: [] };
  // Centroid from the raw rows: the seed is a *vibe*, and biasing it by what
  // the listener recently played would drift the whole target, not just demote
  // individual repeats.
  const seed = seedCentroid(poolRows.map(toOrderable));
  if (!seed) return { seed: null, pool, ranked: [] };

  // The listener asked for these genres; the modal primary of a random 300-row
  // sample is a statistic *about* the tag, not the request — and on an umbrella
  // tag that mostly sits on pop records it comes back as the wrong genre
  // entirely. Only reachable when `stationAffinity` is absent (no genre
  // filter), but wrong is wrong, and the centroid is also what the poll
  // harness freezes.
  if (stationGenres.length) seed.genres = [...stationGenres];

  // Embeddings were NEVER loaded on this path (they are in buildSeedRadio and
  // /songs/:id/similar), so the one axis that actually hears the audio — and
  // the strongest discriminator in the #583 poll data — was silently skipped
  // for every station. Same bug class as #187 B4.
  const model = dominantEmbeddingModel(
    db,
    poolRows.map((r) => r.id),
  );
  if (model) {
    const embeddings = loadEmbeddings(
      db,
      poolRows.map((r) => r.id),
      model,
    );
    for (const c of pool) c.embedding = embeddings.get(c._row.id);
    // A station's audio target is its *centre of gravity*, not its average: the
    // mean of everything wearing a broad tag lands between the modes and is
    // near nothing. See `anchorCentroid`.
    seed.embedding =
      anchorCentroid(
        pool.map((c) => ({ affinity: c.stationAffinity ?? 0.5, embedding: c.embedding })),
      ) ?? undefined;
  }

  // Descriptor blocks (formula v5): attached per member, and the station's
  // descriptor "seed" is the plain centroid of the members that carry them.
  // Not affinity-weighted like the embedding anchor — that weighting was
  // measured inert for embeddings (docs/measurements/radio-stations-2026-08.md),
  // so it is not assumed to help here.
  const descriptors = loadDescriptors(
    db,
    poolRows.map((r) => r.id),
  );
  for (const c of pool) Object.assign(c, blocksFor(descriptors, c._row.id));
  Object.assign(seed, centroidBlocks(pool.map((c) => blocksFor(descriptors, c._row.id))));

  const ranked = rankCandidates(seed, pool, { count, maxPerArtist: 2, weights: opts.weights });
  return { seed, pool, ranked };
}

/**
 * Whose history should demote repeats, or `undefined` when there is no
 * identified listener.
 *
 * `/api/radio` is **not** behind the JWT middleware (see index.ts — every other
 * library route is, which looks like an oversight but is out of scope to change
 * here), so `c.get('user')` is genuinely absent in production. Reading it
 * defensively means an unidentified caller simply gets no recency demotion
 * rather than a 500 — and it stays correct if the route is authenticated later.
 */
function listenerId(c: {
  get: (k: 'user') => AuthEnv['Variables']['user'] | undefined;
}): string | undefined {
  return c.get('user')?.sub;
}

export function radioRoutes() {
  const app = new Hono<AuthEnv>();

  app.get('/next', (c) => {
    const seedId = c.req.query('seedId');
    const count = Math.min(Math.max(Number(c.req.query('count') ?? 10), 1), 50);
    const excludeRaw = c.req.query('exclude') ?? '';
    const excludeIds = new Set(excludeRaw.split(',').filter(Boolean));

    const db = getDatabase();

    // A seed *list* → list-seeded radio ("keep the vibe"). Takes precedence
    // over the single-seed and filter lanes. Capped at the recently-played
    // shelf's size — the pool queries are per-generation, not per-seed, so the
    // cap only bounds the centroid input.
    const seedIdsRaw = c.req.query('seedIds');
    if (seedIdsRaw) {
      const ids = [...new Set(seedIdsRaw.split(',').filter(Boolean))].slice(0, 20);
      const seedRows = ids
        .map((id) =>
          db.query<RadioSongRow, [string]>(`${RADIO_SONG_SELECT} WHERE s.id = ?`).get(id),
        )
        .filter((r): r is RadioSongRow => r != null);
      // Unknown ids are skipped, not fatal — the shelf's list can outlive a
      // deleted song. Only an entirely-unresolvable list is an error.
      if (seedRows.length === 0) return c.json({ error: 'No seed songs found' }, 404);
      return c.json(
        radioSongs(buildListRadio(db, seedRows, { count, excludeIds, userId: listenerId(c) })),
      );
    }

    // No seed song → filter-seeded radio (a mood/genre/bpm vibe). `genre` is a
    // repeated param, so pull the full array before parsing the rest.
    if (!seedId) {
      const q: Record<string, string | string[] | undefined> = { ...c.req.query() };
      const genres = c.req.queries('genre');
      if (genres && genres.length) q['genre'] = genres;
      const filter = parseLibraryFilter(q);
      if (Object.keys(filter).length === 0) {
        return c.json({ error: '"seedId" or a filter is required' }, 400);
      }
      return c.json(
        radioSongs(buildFilterRadio(db, filter, { count, excludeIds, userId: listenerId(c) })),
      );
    }

    const seedRow = db
      .query<RadioSongRow, [string]>(`${RADIO_SONG_SELECT} WHERE s.id = ?`)
      .get(seedId);
    if (!seedRow) return c.json({ error: 'Seed song not found' }, 404);

    return c.json(
      radioSongs(buildSeedRadio(db, seedRow, { count, excludeIds, userId: listenerId(c) })),
    );
  });

  return app;
}
