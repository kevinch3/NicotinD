import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import type { Song } from '@nicotind/core';
import { getDatabase } from '../db.js';
import { rankCandidates, type SongFeatures } from '../services/radio.service.js';

interface RadioSongRow {
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
}

const RADIO_SONG_SELECT = `
  SELECT s.id, s.album_id, a.name AS album_name, a.cover_art AS album_cover_art,
         s.title, s.artist, s.artist_id, s.track, s.duration, s.year, s.genre,
         s.cover_art, s.path, s.size, s.bit_rate, s.suffix, s.content_type,
         s.created, s.starred, s.bpm, s.key
  FROM library_songs s
  LEFT JOIN library_albums a ON a.id = s.album_id
`;

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
  };
}

function toFeatures(r: RadioSongRow): SongFeatures {
  return {
    bpm: r.bpm ?? undefined,
    key: r.key ?? undefined,
    genre: r.genre ?? undefined,
    duration: r.duration,
    year: r.year ?? undefined,
    artistId: r.artist_id,
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

    // Pool 1: same genre (up to 150), most useful signal
    if (seed.genre) {
      const genreRows = db
        .query<RadioSongRow, [string]>(
          `${RADIO_SONG_SELECT} WHERE s.genre = ? AND s.hidden = 0 ORDER BY RANDOM() LIMIT 150`,
        )
        .all(seed.genre);
      for (const r of genreRows) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          candidates.push(r);
        }
      }
    }

    // Pool 2: similar BPM range across genres (± 15%), up to 100
    if (seed.bpm) {
      const bpmLow = Math.round(seed.bpm * 0.85);
      const bpmHigh = Math.round(seed.bpm * 1.15);
      const bpmRows = db
        .query<RadioSongRow, [number, number]>(
          `${RADIO_SONG_SELECT} WHERE s.bpm BETWEEN ? AND ? AND s.hidden = 0
           ORDER BY RANDOM() LIMIT 100`,
        )
        .all(bpmLow, bpmHigh);
      for (const r of bpmRows) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          candidates.push(r);
        }
      }
    }

    // Pool 3: random backfill if we don't have enough candidates
    if (candidates.length < 50) {
      const backfill = db
        .query<RadioSongRow, []>(
          `${RADIO_SONG_SELECT} WHERE s.hidden = 0 ORDER BY RANDOM() LIMIT 100`,
        )
        .all();
      for (const r of backfill) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          candidates.push(r);
        }
      }
    }

    const ranked = rankCandidates(
      seed,
      candidates.map((r) => ({ ...toFeatures(r), _row: r })),
      { count, maxPerArtist: 2 },
    );

    const songs: Song[] = ranked.map((e) =>
      rowToSong((e.song as SongFeatures & { _row: RadioSongRow })._row),
    );

    return c.json(songs);
  });

  return app;
}
