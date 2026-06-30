import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import type { Lidarr } from '@nicotind/lidarr-client';
import type { ProcessingTaskId } from '@nicotind/core';
import {
  analyzeBpm as realAnalyzeBpm,
  analyzeKey as realAnalyzeKey,
  verifyGenre as realVerifyGenre,
} from '../track-analysis.js';
import { readAudioTags, writeAudioTags } from '../audio-tags.js';
import { ffmpegAvailable as realFfmpegAvailable } from '../transcode.js';
import { resolveSongAbsPath, planGenreBackfill } from '../track-backfill.js';
import { setArtwork } from '../artwork-store.js';
import { isPlaceholderArtist } from '../artwork-backfill.js';
import { indexLidarrArtists, resolveArtistImageUrl } from '../artist-image.js';
import { clearCoverNegativeCache } from '../../routes/streaming.js';

/**
 * Enrichment task registry — the single extension point for the windowed library
 * processor. To add a future task (e.g. mood analysis) append one `EnrichmentTask`
 * here; the scheduler discovers it via {@link ENRICHMENT_TASKS} with no other
 * change. Each task reuses the same lower-level primitives as the manual backfill
 * scripts (analyzeBpm / verifyGenre / writeAudioTags), so behaviour matches.
 *
 * All IO-heavy primitives are taken from the injected {@link EnrichmentContext} so
 * tasks are unit-testable with fakes (no real ffmpeg / Lidarr).
 */

interface SongRow {
  id: string;
  path: string;
  artist: string;
  title: string;
}

/** Injected dependencies + swappable primitives for an enrichment run. */
export interface EnrichmentContext {
  musicDir: string;
  /** Canonical-artwork cache dir — passed to setArtwork so a corrected URL purges
   *  its stale thumbnails. */
  coverCacheDir: string;
  lidarr: Lidarr | null;
  /** Worker-pool size for parallelisable tasks (BPM). */
  concurrency: number;
  ffmpegAvailable: () => boolean;
  readTags: (abs: string) => Promise<{ bpm?: number; genre?: string; key?: string }>;
  writeTags: (
    abs: string,
    tags: { bpm?: number; genre?: string; key?: string },
  ) => Promise<boolean>;
  analyzeBpm: (abs: string) => Promise<number | null>;
  /** Detect the musical key (e.g. "C major"), or null when undetectable. */
  analyzeKey: (abs: string) => Promise<string | null>;
  /** Returns the suggested genre for an artist, or null when unavailable. */
  lookupGenre: (artist: string) => Promise<string | null>;
  /** Returns a Spotify portrait url for an artist name, or null. Null when Spotify
   *  isn't configured — the artist-image task then relies on Lidarr alone. */
  lookupArtistImageSpotify: ((name: string) => Promise<string | null>) | null;
  fileExists: (abs: string) => boolean;
}

export interface EnrichmentRunResult {
  applied: number;
  /** Human labels for the items enriched (for log + UI snippets). */
  labels: string[];
}

export interface EnrichmentTask {
  id: ProcessingTaskId;
  label: string;
  /** `true` when runnable, else a human reason it can't run right now. */
  available(ctx: EnrichmentContext): true | string;
  /** Count of songs still needing this task — the resumable predicate. */
  countPending(db: Database): number;
  /** Process up to `limit` pending songs; persist DB + file tag. */
  run(db: Database, ctx: EnrichmentContext, limit: number): Promise<EnrichmentRunResult>;
}

/** Build a context wired to the real primitives. */
export function createEnrichmentContext(deps: {
  musicDir: string;
  coverCacheDir: string;
  lidarr: Lidarr | null;
  concurrency: number;
  /** Spotify portrait lookup, or null when Spotify creds aren't configured. */
  lookupArtistImageSpotify?: ((name: string) => Promise<string | null>) | null;
}): EnrichmentContext {
  return {
    musicDir: deps.musicDir,
    coverCacheDir: deps.coverCacheDir,
    lidarr: deps.lidarr,
    concurrency: deps.concurrency,
    ffmpegAvailable: realFfmpegAvailable,
    readTags: (abs) => readAudioTags(abs),
    writeTags: (abs, tags) => writeAudioTags(abs, tags),
    analyzeBpm: (abs) => realAnalyzeBpm(abs),
    analyzeKey: (abs) => realAnalyzeKey(abs),
    lookupGenre: async (artist) => {
      const r = await realVerifyGenre(deps.lidarr, { artist, currentGenre: null });
      return r.suggested;
    },
    lookupArtistImageSpotify: deps.lookupArtistImageSpotify ?? null,
    fileExists: (abs) => existsSync(abs),
  };
}

const bpmTask: EnrichmentTask = {
  id: 'bpm',
  label: 'BPM analysis',
  available: (ctx) => (ctx.ffmpegAvailable() ? true : 'ffmpeg not found on PATH'),
  countPending: (db) =>
    Number(
      (
        db
          .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM library_songs WHERE bpm IS NULL')
          .get() ?? { n: 0 }
      ).n,
    ),
  run: async (db, ctx, limit) => {
    const rows = db
      .query<
        SongRow,
        [number]
      >('SELECT id, path, artist, title FROM library_songs WHERE bpm IS NULL ORDER BY created DESC LIMIT ?')
      .all(limit);

    const labels: string[] = [];
    let applied = 0;
    let cursor = 0;
    // Bounded worker pool — each analyzeBpm is a slow ffmpeg decode.
    const worker = async (): Promise<void> => {
      for (;;) {
        const idx = cursor++;
        if (idx >= rows.length) return;
        const song = rows[idx]!;
        const abs = resolveSongAbsPath(ctx.musicDir, song.path);
        if (!ctx.fileExists(abs)) continue;
        let bpm: number | null = null;
        let fromTag = false;
        try {
          const tags = await ctx.readTags(abs);
          if (tags.bpm) {
            bpm = tags.bpm;
            fromTag = true;
          } else {
            bpm = await ctx.analyzeBpm(abs);
          }
        } catch {
          bpm = null;
        }
        if (!bpm) continue;
        db.run('UPDATE library_songs SET bpm = ? WHERE id = ?', [bpm, song.id]);
        if (!fromTag) await ctx.writeTags(abs, { bpm }).catch(() => false);
        applied++;
        labels.push(`${song.artist} — ${song.title} → ${bpm} BPM`);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, ctx.concurrency) }, () => worker()));
    return { applied, labels };
  },
};

const genreTask: EnrichmentTask = {
  id: 'genre',
  label: 'Genre',
  available: (ctx) => (ctx.lidarr ? true : 'Lidarr not configured'),
  countPending: (db) =>
    Number(
      (
        db
          .query<
            { n: number },
            []
          >("SELECT COUNT(*) AS n FROM library_songs WHERE genre IS NULL OR genre = ''")
          .get() ?? { n: 0 }
      ).n,
    ),
  run: async (db, ctx, limit) => {
    const rows = db
      .query<
        SongRow,
        [number]
      >("SELECT id, path, artist, title FROM library_songs WHERE genre IS NULL OR genre = '' ORDER BY created DESC LIMIT ?")
      .all(limit);

    // One Lidarr lookup per artist, fanned out to that artist's pending songs.
    const { assignments } = await planGenreBackfill(rows, ctx.lookupGenre);

    const labels: string[] = [];
    let applied = 0;
    for (const a of assignments) {
      db.run('UPDATE library_songs SET genre = ? WHERE id = ?', [a.genre, a.song.id]);
      const abs = resolveSongAbsPath(ctx.musicDir, a.song.path);
      if (ctx.fileExists(abs)) await ctx.writeTags(abs, { genre: a.genre }).catch(() => false);
      applied++;
      labels.push(`${a.song.artist} — ${a.song.title} → ${a.genre}`);
    }
    return { applied, labels };
  },
};

const keyTask: EnrichmentTask = {
  id: 'key',
  label: 'Musical key',
  available: (ctx) => (ctx.ffmpegAvailable() ? true : 'ffmpeg not found on PATH'),
  countPending: (db) =>
    Number(
      (
        db
          .query<
            { n: number },
            []
          >("SELECT COUNT(*) AS n FROM library_songs WHERE key IS NULL OR key = ''")
          .get() ?? { n: 0 }
      ).n,
    ),
  run: async (db, ctx, limit) => {
    const rows = db
      .query<
        SongRow,
        [number]
      >("SELECT id, path, artist, title FROM library_songs WHERE key IS NULL OR key = '' ORDER BY created DESC LIMIT ?")
      .all(limit);

    const labels: string[] = [];
    let applied = 0;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const idx = cursor++;
        if (idx >= rows.length) return;
        const song = rows[idx]!;
        const abs = resolveSongAbsPath(ctx.musicDir, song.path);
        if (!ctx.fileExists(abs)) continue;
        let key: string | null = null;
        let fromTag = false;
        try {
          const tags = await ctx.readTags(abs);
          if (tags.key) {
            key = tags.key;
            fromTag = true;
          } else {
            key = await ctx.analyzeKey(abs);
          }
        } catch {
          key = null;
        }
        if (!key) continue;
        db.run('UPDATE library_songs SET key = ? WHERE id = ?', [key, song.id]);
        if (!fromTag) await ctx.writeTags(abs, { key }).catch(() => false);
        applied++;
        labels.push(`${song.artist} — ${song.title} → ${key}`);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, ctx.concurrency) }, () => worker()));
    return { applied, labels };
  },
};

interface ArtistRow {
  id: string;
  name: string;
}

/**
 * Backfill real artist portraits into `library_artwork (kind='artist')` so the
 * artist grid shows a face, not a (often misleading) representative album cover —
 * which the cover route now declines to serve for an artist id. Resolves each
 * artist via {@link resolveArtistImageUrl} (Lidarr poster → Spotify portrait).
 *
 * Unlike the per-song tasks this works per *artist*: it skips placeholder/VA
 * names and any artist the user manually set (`manual_override = 1`), and
 * processes the most-prolific artists first (`album_count DESC`) so the library's
 * headline names get faces soonest.
 */
const artistImageTask: EnrichmentTask = {
  id: 'artist-image',
  label: 'Artist images',
  available: (ctx) =>
    ctx.lidarr || ctx.lookupArtistImageSpotify ? true : 'Lidarr/Spotify not configured',
  countPending: (db) =>
    Number(
      (
        db
          .query<{ n: number }, []>(
            `SELECT COUNT(*) AS n FROM library_artists a
             WHERE a.hidden = 0 AND a.manual_override = 0
               AND NOT EXISTS (
                 SELECT 1 FROM library_artwork w WHERE w.id = a.id AND w.kind = 'artist')`,
          )
          .get() ?? { n: 0 }
      ).n,
    ),
  run: async (db, ctx, limit) => {
    const rows = db
      .query<
        ArtistRow,
        [number]
      >(`SELECT id, name FROM library_artists a
         WHERE a.hidden = 0 AND a.manual_override = 0
           AND NOT EXISTS (
             SELECT 1 FROM library_artwork w WHERE w.id = a.id AND w.kind = 'artist')
         ORDER BY a.album_count DESC, a.name LIMIT ?`)
      .all(limit);

    // One Lidarr `artist.list()` per batch (not per artist), reused across rows.
    // Wrapped so a Lidarr blip (or, in tests, a partial stub) yields an empty
    // index and the batch still runs via Spotify rather than aborting the whole run.
    let index = null;
    if (ctx.lidarr) {
      const monitored = await (async () => {
        try {
          return await ctx.lidarr!.artist.list();
        } catch {
          return [];
        }
      })();
      index = indexLidarrArtists(monitored);
    }

    const labels: string[] = [];
    let applied = 0;
    for (const artist of rows) {
      if (isPlaceholderArtist(artist.name)) continue;
      const resolved = await resolveArtistImageUrl(
        db,
        { lidarr: ctx.lidarr, index, spotifyLookup: ctx.lookupArtistImageSpotify },
        artist,
      );
      if (!resolved) continue;
      setArtwork(db, artist.id, 'artist', resolved.url, ctx.coverCacheDir);
      // Evict any cached 404 for this artist id so the new portrait shows at once.
      clearCoverNegativeCache(artist.id);
      applied++;
      labels.push(`${artist.name} → ${resolved.source}`);
    }
    return { applied, labels };
  },
};

/** All registered enrichment tasks, in run order. */
export const ENRICHMENT_TASKS: readonly EnrichmentTask[] = [
  bpmTask,
  genreTask,
  keyTask,
  artistImageTask,
];

export function getTask(id: ProcessingTaskId): EnrichmentTask | undefined {
  return ENRICHMENT_TASKS.find((t) => t.id === id);
}
