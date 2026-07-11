import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import type { Lidarr } from '@nicotind/lidarr-client';
import type { ProcessingTaskId } from '@nicotind/core';
import {
  analyzeBpm as realAnalyzeBpm,
  analyzeKey as realAnalyzeKey,
  verifyGenre as realVerifyGenre,
  NoConfidentResultError,
} from '../track-analysis.js';
import { readAudioTags, writeAudioTags, type FeatureTags } from '../audio-tags.js';
import { analyzeLoudness as realAnalyzeLoudness } from '../loudness-analysis.js';
import type { LoudnessResult } from '../loudness-analysis.js';
import type {
  AudioFeaturesClient,
  AudioFeaturesResult,
  RhythmResult,
} from '../audio-features-client.js';
import { AudioFileRejectedError } from '../audio-features-client.js';
import { ffmpegAvailable as realFfmpegAvailable } from '../transcode.js';
import { resolveSongAbsPath, planGenreBackfill } from '../track-backfill.js';
import { setArtwork } from '../artwork-store.js';
import { isPlaceholderArtist } from '../artwork-backfill.js';
import { indexLidarrArtists, resolveArtistImageUrl } from '../artist-image.js';
import { clearCoverNegativeCache } from '../../routes/streaming.js';
import {
  recordAnalysisFailure,
  clearAnalysisFailure,
  notPermanentlyFailedClause,
} from './analysis-failures.js';

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
  /** Byte size — recorded with a failure so a re-download (size change) resets it. */
  size: number | null;
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
  readTags: (abs: string) => Promise<{ bpm?: number; genre?: string; key?: string } & FeatureTags>;
  writeTags: (
    abs: string,
    tags: { bpm?: number; genre?: string; key?: string } & FeatureTags,
  ) => Promise<boolean>;
  analyzeBpm: (abs: string, onError?: (err: unknown) => void) => Promise<number | null>;
  /** Sidecar tempo detection (library-relative path) — preferred over the local
   *  music-tempo analyzer, which makes frequent octave (half/double) errors.
   *  Null when no sidecar is configured; a null *result* means an environmental
   *  failure and falls back to {@link analyzeBpm}. */
  analyzeRhythm: ((relPath: string) => Promise<RhythmResult | null>) | null;
  /** Detect the musical key (e.g. "C major"), or null when undetectable. */
  analyzeKey: (abs: string, onError?: (err: unknown) => void) => Promise<string | null>;
  /** Measure integrated loudness + derived energy, or null on decode failure. */
  analyzeLoudness: (
    abs: string,
    onError?: (err: unknown) => void,
  ) => Promise<LoudnessResult | null>;
  /** Analyze one track via the analysis sidecar (library-relative path), or
   *  null on failure. Null client when NICOTIND_ANALYSIS_URL isn't configured. */
  analyzeAudioFeatures: ((relPath: string) => Promise<AudioFeaturesResult | null>) | null;
  /** Last-known sidecar health (sync — the availability hook can't await). */
  audioFeaturesAvailable: () => boolean;
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
  /** Items that were attempted (file present, work needed) but errored. */
  failed: number;
  /** A representative failure reason from this run, or null when none failed. */
  errorSample: string | null;
}

/** Mutable accumulator a task worker uses to tally failures + keep one sample. */
interface FailureTally {
  failed: number;
  sample: string | null;
}

function recordFailure(tally: FailureTally, err: unknown): void {
  tally.failed++;
  if (tally.sample === null) tally.sample = err instanceof Error ? err.message : String(err);
}

/**
 * A hard per-item failure: tally it for this run's reporting *and* persist it to
 * the per-file ledger so a permanently-broken file eventually drops out of the
 * task's pending set (see analysis-failures.ts).
 *
 * A {@link NoConfidentResultError} ("analysis ran, found nothing") is ledgered —
 * otherwise the same undetectable files head the created-DESC queue and are
 * re-decoded every batch forever, starving everything behind them — but NOT
 * tallied as a run failure: nothing is broken, so it must not trip the panel
 * banner or the Sentry report.
 */
function noteItemFailure(
  db: Database,
  tally: FailureTally,
  song: SongRow,
  task: ProcessingTaskId,
  err: unknown,
): void {
  if (!(err instanceof NoConfidentResultError)) recordFailure(tally, err);
  recordAnalysisFailure(db, song.id, task, err, song.size);
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
  /** Sidecar client, or null when NICOTIND_ANALYSIS_URL isn't configured. */
  audioFeaturesClient?: AudioFeaturesClient | null;
}): EnrichmentContext {
  const featuresClient = deps.audioFeaturesClient ?? null;
  return {
    musicDir: deps.musicDir,
    coverCacheDir: deps.coverCacheDir,
    lidarr: deps.lidarr,
    concurrency: deps.concurrency,
    ffmpegAvailable: realFfmpegAvailable,
    readTags: (abs) => readAudioTags(abs),
    writeTags: (abs, tags) => writeAudioTags(abs, tags),
    analyzeBpm: (abs, onError) => realAnalyzeBpm(abs, onError),
    analyzeRhythm: featuresClient ? (relPath) => featuresClient.rhythm(relPath) : null,
    analyzeKey: (abs, onError) => realAnalyzeKey(abs, onError),
    analyzeLoudness: (abs, onError) => realAnalyzeLoudness(abs, onError),
    analyzeAudioFeatures: featuresClient ? (relPath) => featuresClient.analyze(relPath) : null,
    audioFeaturesAvailable: () => featuresClient?.healthySnapshot() ?? false,
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
          .query<{ n: number }, []>(
            `SELECT COUNT(*) AS n FROM library_songs WHERE bpm IS NULL${notPermanentlyFailedClause('bpm')}`,
          )
          .get() ?? { n: 0 }
      ).n,
    ),
  run: async (db, ctx, limit) => {
    const rows = db
      .query<SongRow, [number]>(
        `SELECT id, path, artist, title, size FROM library_songs WHERE bpm IS NULL${notPermanentlyFailedClause('bpm')} ORDER BY created DESC LIMIT ?`,
      )
      .all(limit);

    const labels: string[] = [];
    const tally: FailureTally = { failed: 0, sample: null };
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
            if (ctx.analyzeRhythm) {
              try {
                const r = await ctx.analyzeRhythm(song.path);
                if (r) bpm = Math.round(r.bpm);
              } catch (err) {
                if (err instanceof AudioFileRejectedError) {
                  // Un-decodable per the sidecar (422) — the local decoder would
                  // fail on the same bytes; ledger once and skip the fallback.
                  noteItemFailure(db, tally, song, 'bpm', err);
                  continue;
                }
                // Transport-level throw: treat like an outage, use the fallback.
              }
            }
            if (!bpm) {
              bpm = await ctx.analyzeBpm(abs, (err) =>
                noteItemFailure(db, tally, song, 'bpm', err),
              );
            }
          }
        } catch (err) {
          noteItemFailure(db, tally, song, 'bpm', err);
          bpm = null;
        }
        if (!bpm) continue;
        db.run('UPDATE library_songs SET bpm = ? WHERE id = ?', [bpm, song.id]);
        if (!fromTag) await ctx.writeTags(abs, { bpm }).catch(() => false);
        clearAnalysisFailure(db, song.id, 'bpm');
        applied++;
        labels.push(`${song.artist} — ${song.title} → ${bpm} BPM`);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, ctx.concurrency) }, () => worker()));
    return { applied, labels, failed: tally.failed, errorSample: tally.sample };
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
          .query<{ n: number }, []>(
            `SELECT COUNT(*) AS n FROM library_songs WHERE (genre IS NULL OR genre = '')${notPermanentlyFailedClause(
              'genre',
            )}`,
          )
          .get() ?? { n: 0 }
      ).n,
    ),
  run: async (db, ctx, limit) => {
    const rows = db
      .query<SongRow, [number]>(
        `SELECT id, path, artist, title, size FROM library_songs WHERE (genre IS NULL OR genre = '')${notPermanentlyFailedClause(
          'genre',
        )} ORDER BY created DESC LIMIT ?`,
      )
      .all(limit);

    // One Lidarr lookup per artist, fanned out to that artist's pending songs.
    const { assignments } = await planGenreBackfill(rows, ctx.lookupGenre);

    // Songs whose artist Lidarr can't resolve stay pending and would be
    // re-queried every batch forever — starving the queue. Ledger each so it
    // drops out of the pending set after {@link MAX_ANALYSIS_ATTEMPTS} attempts
    // (a re-tag/re-download changes the size and re-includes). This is NOT
    // tallied as a run failure: nothing is broken, Lidarr simply has no genre.
    const resolved = new Set(assignments.map((a) => a.song.id));
    const unresolvable = new Error('Lidarr has no genre for this artist');
    for (const song of rows) {
      if (resolved.has(song.id)) clearAnalysisFailure(db, song.id, 'genre');
      else recordAnalysisFailure(db, song.id, 'genre', unresolvable, song.size);
    }

    const labels: string[] = [];
    let applied = 0;
    for (const a of assignments) {
      db.run('UPDATE library_songs SET genre = ? WHERE id = ?', [a.genre, a.song.id]);
      const abs = resolveSongAbsPath(ctx.musicDir, a.song.path);
      if (ctx.fileExists(abs)) await ctx.writeTags(abs, { genre: a.genre }).catch(() => false);
      applied++;
      labels.push(`${a.song.artist} — ${a.song.title} → ${a.genre}`);
    }
    return { applied, labels, failed: 0, errorSample: null };
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
          .query<{ n: number }, []>(
            `SELECT COUNT(*) AS n FROM library_songs WHERE (key IS NULL OR key = '')${notPermanentlyFailedClause('key')}`,
          )
          .get() ?? { n: 0 }
      ).n,
    ),
  run: async (db, ctx, limit) => {
    const rows = db
      .query<SongRow, [number]>(
        `SELECT id, path, artist, title, size FROM library_songs WHERE (key IS NULL OR key = '')${notPermanentlyFailedClause('key')} ORDER BY created DESC LIMIT ?`,
      )
      .all(limit);

    const labels: string[] = [];
    const tally: FailureTally = { failed: 0, sample: null };
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
            key = await ctx.analyzeKey(abs, (err) => noteItemFailure(db, tally, song, 'key', err));
          }
        } catch (err) {
          noteItemFailure(db, tally, song, 'key', err);
          key = null;
        }
        if (!key) continue;
        db.run('UPDATE library_songs SET key = ? WHERE id = ?', [key, song.id]);
        if (!fromTag) await ctx.writeTags(abs, { key }).catch(() => false);
        clearAnalysisFailure(db, song.id, 'key');
        applied++;
        labels.push(`${song.artist} — ${song.title} → ${key}`);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, ctx.concurrency) }, () => worker()));
    return { applied, labels, failed: tally.failed, errorSample: tally.sample };
  },
};

/**
 * Fill `energy` + `loudness` from ffmpeg's EBU R128 measurement. Tag-first like
 * bpm/key: a file that already carries an ENERGY tag (e.g. analyzed on another
 * install) is adopted without re-decoding. Loudness is only a by-product column
 * — the resumable predicate keys on `energy IS NULL` alone.
 */
const energyTask: EnrichmentTask = {
  id: 'energy',
  label: 'Energy & loudness',
  available: (ctx) => (ctx.ffmpegAvailable() ? true : 'ffmpeg not found on PATH'),
  countPending: (db) =>
    Number(
      (
        db
          .query<{ n: number }, []>(
            `SELECT COUNT(*) AS n FROM library_songs WHERE energy IS NULL${notPermanentlyFailedClause('energy')}`,
          )
          .get() ?? { n: 0 }
      ).n,
    ),
  run: async (db, ctx, limit) => {
    const rows = db
      .query<SongRow, [number]>(
        `SELECT id, path, artist, title, size FROM library_songs WHERE energy IS NULL${notPermanentlyFailedClause('energy')} ORDER BY created DESC LIMIT ?`,
      )
      .all(limit);

    const labels: string[] = [];
    const tally: FailureTally = { failed: 0, sample: null };
    let applied = 0;
    let cursor = 0;
    // Bounded worker pool — each analyzeLoudness is a full-file ffmpeg decode.
    const worker = async (): Promise<void> => {
      for (;;) {
        const idx = cursor++;
        if (idx >= rows.length) return;
        const song = rows[idx]!;
        const abs = resolveSongAbsPath(ctx.musicDir, song.path);
        if (!ctx.fileExists(abs)) continue;
        let result: LoudnessResult | null = null;
        let fromTag = false;
        try {
          const tags = await ctx.readTags(abs);
          if (tags.energy !== undefined) {
            result = { energy: tags.energy, loudness: tags.loudness ?? NaN };
            fromTag = true;
          } else {
            result = await ctx.analyzeLoudness(abs, (err) =>
              noteItemFailure(db, tally, song, 'energy', err),
            );
          }
        } catch (err) {
          noteItemFailure(db, tally, song, 'energy', err);
          result = null;
        }
        if (!result) continue;
        const loudness = Number.isFinite(result.loudness) ? result.loudness : null;
        db.run('UPDATE library_songs SET energy = ?, loudness = ? WHERE id = ?', [
          result.energy,
          loudness,
          song.id,
        ]);
        if (!fromTag) {
          await ctx
            .writeTags(abs, { energy: result.energy, loudness: loudness ?? undefined })
            .catch(() => false);
        }
        clearAnalysisFailure(db, song.id, 'energy');
        applied++;
        labels.push(`${song.artist} — ${song.title} → energy ${result.energy.toFixed(2)}`);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, ctx.concurrency) }, () => worker()));
    return { applied, labels, failed: tally.failed, errorSample: tally.sample };
  },
};

/**
 * Fill danceability/valence/acousticness/instrumental/mood (+ the cached
 * embedding) from the analysis sidecar. Tag-first: a file already carrying all
 * five feature tags is adopted without a sidecar call (no embedding in that
 * case — embeddings only come from analysis). Gated on live sidecar health;
 * a mid-batch sidecar loss just leaves the remaining songs pending.
 */
const audioFeaturesTask: EnrichmentTask = {
  id: 'audio-features',
  label: 'Audio features (mood/valence/danceability)',
  available: (ctx) => {
    if (!ctx.analyzeAudioFeatures) return 'analysis sidecar not configured';
    return ctx.audioFeaturesAvailable() ? true : 'analysis sidecar unreachable';
  },
  countPending: (db) =>
    Number(
      (
        db
          .query<{ n: number }, []>(
            `SELECT COUNT(*) AS n FROM library_songs WHERE danceability IS NULL${notPermanentlyFailedClause(
              'audio-features',
            )}`,
          )
          .get() ?? { n: 0 }
      ).n,
    ),
  run: async (db, ctx, limit) => {
    const rows = db
      .query<SongRow, [number]>(
        `SELECT id, path, artist, title, size FROM library_songs WHERE danceability IS NULL${notPermanentlyFailedClause(
          'audio-features',
        )} ORDER BY created DESC LIMIT ?`,
      )
      .all(limit);

    const labels: string[] = [];
    const tally: FailureTally = { failed: 0, sample: null };
    let applied = 0;
    let cursor = 0;
    // The sidecar serializes inference internally, so more than 2 in flight
    // only queues — keep the pool small regardless of ctx.concurrency.
    const worker = async (): Promise<void> => {
      for (;;) {
        const idx = cursor++;
        if (idx >= rows.length) return;
        const song = rows[idx]!;
        const abs = resolveSongAbsPath(ctx.musicDir, song.path);
        if (!ctx.fileExists(abs)) continue;

        // Tag-first: adopt a fully-tagged file without re-analysis.
        let tagged: FeatureTags | null = null;
        try {
          const tags = await ctx.readTags(abs);
          if (
            tags.danceability !== undefined &&
            tags.valence !== undefined &&
            tags.acousticness !== undefined &&
            tags.instrumental !== undefined &&
            tags.mood !== undefined
          ) {
            tagged = tags;
          }
        } catch {
          tagged = null;
        }
        if (tagged) {
          db.run(
            `UPDATE library_songs SET danceability = ?, valence = ?, acousticness = ?, instrumental = ?, mood = ? WHERE id = ?`,
            [
              tagged.danceability!,
              tagged.valence!,
              tagged.acousticness!,
              tagged.instrumental!,
              tagged.mood!,
              song.id,
            ],
          );
          applied++;
          labels.push(`${song.artist} — ${song.title} → ${tagged.mood} (tags)`);
          continue;
        }

        if (!ctx.analyzeAudioFeatures) return;
        let result: AudioFeaturesResult | null = null;
        try {
          result = await ctx.analyzeAudioFeatures(song.path);
        } catch (err) {
          if (err instanceof AudioFileRejectedError) {
            // The file is genuinely un-decodable (sidecar 422) — ledger it so
            // it stops being retried forever (mirrors bpm/key/energy corrupt
            // files). Count it as a run failure: the file is bad.
            noteItemFailure(db, tally, song, 'audio-features', err);
          } else {
            // An unexpected throw from the client (transport error). Treat it
            // like an outage unless we can still reach the sidecar.
            if (!ctx.audioFeaturesAvailable()) return;
            recordFailure(tally, err instanceof Error ? err : new Error(String(err)));
          }
          continue;
        }
        if (!result) {
          // Sidecar gone mid-batch? Stop pulling more work; songs stay pending
          // (an outage, not a per-file failure — don't count it against the file).
          if (!ctx.audioFeaturesAvailable()) return;
          // Sidecar is up but returned no result (e.g. 404 — file not visible
          // to the sidecar, usually a mount mismatch). Don't ledger: a misconfig
          // would otherwise exclude the whole library; count it as a failure
          // so the run still surfaces the problem.
          recordFailure(tally, new Error('analysis sidecar could not analyze file (see logs)'));
          continue;
        }
        const f = result.features;
        const tx = db.transaction(() => {
          db.run(
            `UPDATE library_songs SET danceability = ?, valence = ?, acousticness = ?, instrumental = ?, mood = ? WHERE id = ?`,
            [f.danceability, f.valence, f.acousticness, f.instrumental, f.mood, song.id],
          );
          db.run(
            `INSERT OR REPLACE INTO library_embeddings (song_id, model, dim, vec, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
            [
              song.id,
              result.embedding.model,
              result.embedding.dim,
              Buffer.from(new Float32Array(result.embedding.values).buffer),
              Date.now(),
            ],
          );
        });
        tx();
        await ctx
          .writeTags(abs, {
            danceability: f.danceability,
            valence: f.valence,
            acousticness: f.acousticness,
            instrumental: f.instrumental,
            mood: f.mood,
          })
          .catch(() => false);
        clearAnalysisFailure(db, song.id, 'audio-features');
        applied++;
        labels.push(`${song.artist} — ${song.title} → ${f.mood}`);
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(ctx.concurrency, 2)) }, () => worker()),
    );
    return { applied, labels, failed: tally.failed, errorSample: tally.sample };
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
      .query<ArtistRow, [number]>(
        `SELECT id, name FROM library_artists a
         WHERE a.hidden = 0 AND a.manual_override = 0
           AND NOT EXISTS (
             SELECT 1 FROM library_artwork w WHERE w.id = a.id AND w.kind = 'artist')
         ORDER BY a.album_count DESC, a.name LIMIT ?`,
      )
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
    return { applied, labels, failed: 0, errorSample: null };
  },
};

/** All registered enrichment tasks, in run order. */
export const ENRICHMENT_TASKS: readonly EnrichmentTask[] = [
  bpmTask,
  genreTask,
  keyTask,
  energyTask,
  audioFeaturesTask,
  artistImageTask,
];

export function getTask(id: ProcessingTaskId): EnrichmentTask | undefined {
  return ENRICHMENT_TASKS.find((t) => t.id === id);
}
