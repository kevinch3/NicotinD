import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { getDatabase } from '../db.js';
import { PlaylistService } from '../services/playlist.service.js';
import { RADIO_SONG_SELECT, toFeatures, longestGenreToken, type RadioSongRow } from './radio.js';
import { rankCandidates, type SongFeatures } from '../services/radio.service.js';
import { embeddingModelFor, loadEmbeddings } from '../services/embedding-store.js';
import { orderTracks, seedCentroid, type OrderableRow } from '../services/playlist-recipe.js';

/** RadioSongRow → the row shape the ordering/centroid helpers consume. */
function toOrderable(r: RadioSongRow): OrderableRow {
  return {
    id: r.id,
    artist: r.artist,
    artistId: r.artist_id,
    bpm: r.bpm ?? undefined,
    key: r.key ?? undefined,
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

/** Component-wise mean of equal-length embeddings; undefined for an empty set.
 *  Vectors of a different length than the first are skipped (can't average). */
function meanEmbedding(vecs: readonly Float32Array[]): Float32Array | undefined {
  const first = vecs[0];
  if (!first) return undefined;
  const acc = new Float32Array(first.length);
  let n = 0;
  for (const v of vecs) {
    if (v.length !== first.length) continue;
    for (let i = 0; i < first.length; i++) acc[i]! += v[i]!;
    n++;
  }
  if (n === 0) return undefined;
  for (let i = 0; i < acc.length; i++) acc[i]! /= n;
  return acc;
}

/**
 * Native per-user playlists. Every handler scopes to the authenticated user
 * (`c.var.user.sub`) so playlists are private to their owner.
 */
export function playlistRoutes() {
  const app = new Hono<AuthEnv>();
  const svc = () => new PlaylistService(getDatabase());

  app.get('/', (c) => c.json({ playlists: svc().list(c.var.user.sub) }));

  app.get('/:id', (c) => {
    const detail = svc().get(c.var.user.sub, c.req.param('id'));
    return detail ? c.json(detail) : c.json({ error: 'Not found' }, 404);
  });

  app.post('/', async (c) => {
    type Body = { name?: string; description?: string; songIds?: string[] };
    const body = await c.req.json<Body>().catch(() => ({}) as Body);
    if (!body.name || !body.name.trim()) {
      return c.json({ error: 'name is required' }, 400);
    }
    const playlist = svc().create(c.var.user.sub, {
      name: body.name,
      description: body.description,
      songIds: body.songIds,
    });
    return c.json({ playlist }, 201);
  });

  /**
   * Generate a playlist from a seed and persist it as a normal editable user
   * playlist. Seeds: a single song, an artist's catalogue, or the starred set.
   * Reuses the Radio scorer (`rankCandidates`) over the same query shape, then
   * harmonically orders the result. The catalogue is the source of truth — only
   * existing songs are selected (no invented ids).
   */
  app.post('/generate', async (c) => {
    type Seed = { songId?: string; artistId?: string; starred?: boolean };
    type Body = { seed?: Seed; name?: string; size?: number };
    const body = await c.req.json<Body>().catch(() => ({}) as Body);
    const seedSpec = body.seed ?? {};
    const size = Math.min(Math.max(Number(body.size ?? 30), 1), 100);
    const db = getDatabase();

    // Resolve the seed songs + the SongFeatures to score against.
    let seedRows: RadioSongRow[] = [];
    let defaultName = 'Generated playlist';
    if (seedSpec.songId) {
      const row = db
        .query<RadioSongRow, [string]>(`${RADIO_SONG_SELECT} WHERE s.id = ?`)
        .get(seedSpec.songId);
      if (row) {
        seedRows = [row];
        defaultName = `Like "${row.title}"`;
      }
    } else if (seedSpec.artistId) {
      seedRows = db
        .query<RadioSongRow, [string]>(
          `${RADIO_SONG_SELECT} WHERE s.artist_id = ? AND s.hidden = 0`,
        )
        .all(seedSpec.artistId);
      if (seedRows.length) defaultName = `Inspired by ${seedRows[0].artist}`;
    } else if (seedSpec.starred) {
      seedRows = db
        .query<RadioSongRow, []>(
          `${RADIO_SONG_SELECT} WHERE s.starred IS NOT NULL AND s.hidden = 0`,
        )
        .all();
      defaultName = 'From your favorites';
    } else {
      return c.json({ error: 'seed must specify songId, artistId, or starred' }, 400);
    }

    if (seedRows.length === 0) return c.json({ error: 'Seed matched no songs' }, 404);

    const seedFeatures: SongFeatures | null =
      seedRows.length === 1
        ? toFeatures(seedRows[0])
        : seedCentroid(seedRows.map(toOrderable));
    if (!seedFeatures) return c.json({ error: 'Seed matched no songs' }, 404);

    // Candidate pool: same genre + a random cross-genre sample for diversity.
    const exclude = new Set(seedRows.map((r) => r.id));
    const seen = new Set(exclude);
    const candidates: RadioSongRow[] = [];
    const addRows = (rows: RadioSongRow[]) => {
      for (const r of rows)
        if (!seen.has(r.id)) {
          seen.add(r.id);
          candidates.push(r);
        }
    };
    if (seedFeatures.genre) {
      addRows(
        db
          .query<RadioSongRow, [string]>(
            `${RADIO_SONG_SELECT} WHERE s.genre = ? AND s.hidden = 0 ORDER BY RANDOM() LIMIT 300`,
          )
          .all(seedFeatures.genre),
      );
    }
    // Genre-variant match via the seed's longest token so lexical genre
    // closeness has variants ("Deep House" ↔ "House") to score, not just exact.
    const genreToken = longestGenreToken(seedFeatures.genre);
    if (genreToken) {
      addRows(
        db
          .query<RadioSongRow, [string]>(
            `${RADIO_SONG_SELECT} WHERE LOWER(s.genre) LIKE '%' || ? || '%' AND s.hidden = 0
             ORDER BY RANDOM() LIMIT 150`,
          )
          .all(genreToken),
      );
    }
    // Un-analyzed tracks get a guaranteed seat so a mid-backfill library stays
    // discoverable to the generator.
    addRows(
      db
        .query<RadioSongRow, []>(
          `${RADIO_SONG_SELECT} WHERE (s.bpm IS NULL OR s.energy IS NULL) AND s.hidden = 0
           ORDER BY RANDOM() LIMIT 60`,
        )
        .all(),
    );
    addRows(
      db
        .query<RadioSongRow, []>(
          `${RADIO_SONG_SELECT} WHERE s.hidden = 0 ORDER BY RANDOM() LIMIT 300`,
        )
        .all(),
    );

    // Attach cached embeddings (seed + pool) so the scorer's cosine axis
    // engages when present. For a multi-song seed (artist/starred) the seed
    // embedding is the mean over the seed rows that carry one — the vector
    // analogue of seedCentroid's mean-of-fields.
    const model = seedRows[0] ? embeddingModelFor(db, seedRows[0].id) : null;
    const embeddings = model
      ? loadEmbeddings(db, [...seedRows.map((r) => r.id), ...candidates.map((r) => r.id)], model)
      : new Map<string, Float32Array>();
    const seedVecs = seedRows.map((r) => embeddings.get(r.id)).filter((v): v is Float32Array => !!v);
    seedFeatures.embedding = meanEmbedding(seedVecs);

    const ranked = rankCandidates(
      seedFeatures,
      candidates.map((r) => ({ ...toFeatures(r), embedding: embeddings.get(r.id), _row: r })),
      { count: size, maxPerArtist: 2 },
    );
    const orderedRows = orderTracks(
      ranked.map((e) => toOrderable((e.song as SongFeatures & { _row: RadioSongRow })._row)),
      'harmonic',
    );
    const songIds = orderedRows.map((r) => r.id);
    if (songIds.length === 0) return c.json({ error: 'No matching songs to generate from' }, 404);

    const name = body.name?.trim() || defaultName;
    const playlist = svc().create(c.var.user.sub, { name, songIds });
    return c.json({ playlist }, 201);
  });

  app.put('/:id', async (c) => {
    type Body = {
      name?: string;
      description?: string;
      add?: string[];
      remove?: string[];
      reorder?: string[];
    };
    const body = await c.req.json<Body>().catch(() => ({}) as Body);
    const ok = svc().update(c.var.user.sub, c.req.param('id'), body);
    return ok ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404);
  });

  app.delete('/:id', (c) => {
    const ok = svc().remove(c.var.user.sub, c.req.param('id'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404);
  });

  return app;
}
