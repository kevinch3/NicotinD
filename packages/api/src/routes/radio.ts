import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import type { Song } from '@nicotind/core';
import { getDatabase } from '../db.js';
import { rankCandidates, type SongFeatures } from '../services/radio.service.js';
import { embeddingModelFor, loadEmbeddings } from '../services/embedding-store.js';

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
          )) AS genres_all
  FROM library_songs s
  LEFT JOIN library_albums a ON a.id = s.album_id
`;

/** Full genre set from the aggregated join-table column (primary-first). */
export function genresOf(r: RadioSongRow): string[] | undefined {
  if (r.genres_all) return r.genres_all.split('; ');
  return r.genre ? [r.genre] : undefined;
}

function rowToSong(r: RadioSongRow): Song & SongFeatures {
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

export function radioRoutes() {
  const app = new Hono<AuthEnv>();

  app.get('/next', (c) => {
    const seedId = c.req.query('seedId');
    if (!seedId) return c.json({ error: '"seedId" is required' }, 400);

    const count = Math.min(Math.max(Number(c.req.query('count') ?? 10), 1), 50);
    const excludeRaw = c.req.query('exclude') ?? '';
    const excludeIds = new Set(excludeRaw.split(',').filter(Boolean));
    excludeIds.add(seedId);

    const db = getDatabase();

    const seedRow = db
      .query<RadioSongRow, [string]>(`${RADIO_SONG_SELECT} WHERE s.id = ?`)
      .get(seedId);
    if (!seedRow) return c.json({ error: 'Seed song not found' }, 404);

    const seed = toFeatures(seedRow);

    // Build a candidate pool: same genre (broad match) + random sample for diversity
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
    const seedGenres = seed.genres ?? (seed.genre ? [seed.genre] : []);
    if (seedGenres.length > 0) {
      const marks = seedGenres.map(() => '?').join(', ');
      addRows(
        db
          .query<RadioSongRow, string[]>(
            `${RADIO_SONG_SELECT}
             WHERE (s.genre IN (${marks}) OR EXISTS (
               SELECT 1 FROM library_song_genres g WHERE g.song_id = s.id AND g.genre IN (${marks})
             )) AND s.hidden = 0 AND s.landed_at IS NOT NULL ORDER BY RANDOM() LIMIT 150`,
          )
          .all(...seedGenres, ...seedGenres),
      );
    }

    // Pool 1b: genre-variant match via the seed's longest token (e.g. seed
    // "Deep House" also pulls "House"/"Tech House"), so lexical genre closeness
    // has variants to score instead of only exact-string matches.
    const genreToken = longestGenreToken(seed.genre);
    if (genreToken) {
      addRows(
        db
          .query<RadioSongRow, [string]>(
            `${RADIO_SONG_SELECT} WHERE LOWER(s.genre) LIKE '%' || ? || '%' AND s.hidden = 0 AND s.landed_at IS NOT NULL
             ORDER BY RANDOM() LIMIT 100`,
          )
          .all(genreToken),
      );
    }

    // Pool 2: similar BPM range across genres (± 15%), up to 100
    if (seed.bpm) {
      const bpmLow = Math.round(seed.bpm * 0.85);
      const bpmHigh = Math.round(seed.bpm * 1.15);
      addRows(
        db
          .query<RadioSongRow, [number, number]>(
            `${RADIO_SONG_SELECT} WHERE s.bpm BETWEEN ? AND ? AND s.hidden = 0 AND s.landed_at IS NOT NULL
             ORDER BY RANDOM() LIMIT 100`,
          )
          .all(bpmLow, bpmHigh),
      );
    }

    // Pool 3: energy-adjacent across genres (±0.15), up to 100 — keeps the
    // set's momentum coherent once the library carries energy values.
    if (seed.energy !== undefined) {
      addRows(
        db
          .query<RadioSongRow, [number, number]>(
            `${RADIO_SONG_SELECT} WHERE s.energy BETWEEN ? AND ? AND s.hidden = 0 AND s.landed_at IS NOT NULL
             ORDER BY RANDOM() LIMIT 100`,
          )
          .all(Math.max(0, seed.energy - 0.15), Math.min(1, seed.energy + 0.15)),
      );
    }

    // Pool 4: un-analyzed tracks (no bpm/energy) get a guaranteed seat so a
    // mid-backfill library stays discoverable and radio doesn't tunnel on the
    // already-analyzed slice.
    addRows(
      db
        .query<RadioSongRow, []>(
          `${RADIO_SONG_SELECT} WHERE (s.bpm IS NULL OR s.energy IS NULL) AND s.hidden = 0 AND s.landed_at IS NOT NULL
           ORDER BY RANDOM() LIMIT 30`,
        )
        .all(),
    );

    // Pool 5: random backfill if we still don't have enough candidates
    if (candidates.length < 50) {
      addRows(
        db
          .query<RadioSongRow, []>(
            `${RADIO_SONG_SELECT} WHERE s.hidden = 0 AND s.landed_at IS NOT NULL ORDER BY RANDOM() LIMIT 100`,
          )
          .all(),
      );
    }

    // Attach cached embeddings (seed + pool) so the scorer can add the cosine
    // axis. No-op when the seed has no embedding (comparison needs both sides).
    const model = embeddingModelFor(db, seedId);
    const embeddings = model
      ? loadEmbeddings(db, [seedId, ...candidates.map((r) => r.id)], model)
      : new Map<string, Float32Array>();
    seed.embedding = embeddings.get(seedId);

    const ranked = rankCandidates(
      seed,
      candidates.map((r) => ({ ...toFeatures(r), embedding: embeddings.get(r.id), _row: r })),
      { count, maxPerArtist: 2 },
    );

    const songs: Song[] = ranked.map((e) =>
      rowToSong((e.song as SongFeatures & { _row: RadioSongRow })._row),
    );

    return c.json(songs);
  });

  return app;
}
