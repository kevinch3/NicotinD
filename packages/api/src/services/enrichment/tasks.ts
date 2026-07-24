import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Lidarr, LidarrArtist } from '@nicotind/lidarr-client';
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
import { appendSongGenres, setSongGenres } from '../genre-split.js';
import { applyGenreOverride, upsertGenreOverride, type OverrideIndex } from '../genre-overrides.js';
import { setArtwork } from '../artwork-store.js';
import { isPlaceholderArtist } from '../artwork-backfill.js';
import { indexLidarrArtists, resolveArtistImageUrl } from '../artist-image.js';
import {
  buildArtistImageProviders,
  configuredArtistImageSources,
} from '../artist-image-providers.js';
import { clearCoverNegativeCache } from '../../routes/streaming.js';
import { normalizeArtistForGrouping } from '../album-grouping.js';
import { splitOnDelimiters } from '../artist-split.js';
import { upsertArtistIdentity } from '../artist-identity-store.js';
import { artistIdFor } from '../library-scanner.js';
import { MusicBrainzClient, MB_USER_AGENT } from '../musicbrainz-client.js';
import { getMbid, upsertMbid } from '../mbid-store.js';
import { upsertArtistMeta } from '../artist-meta-store.js';
import type { ArtistInfoResult } from '@nicotind/core';
import {
  recordAnalysisFailure,
  clearAnalysisFailure,
  notPermanentlyFailedClause,
} from './analysis-failures.js';

/** A licence resolved for one song, with its provenance. */
export interface LicenceLookupResult {
  code: string;
  source: 'tag' | 'musicbrainz';
}

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
  readTags: (
    abs: string,
  ) => Promise<{ bpm?: number; genre?: string; key?: string; licence?: string } & FeatureTags>;
  writeTags: (
    abs: string,
    tags: { bpm?: number; genre?: string; key?: string; licence?: string } & FeatureTags,
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
  /**
   * Resolve a rights/licence code for one song — the file's own LICENSE/COPYRIGHT
   * tag first (zero network), then a MusicBrainz `license` url-relation. Returns
   * null when nothing is confidently found (the common case; MB coverage is
   * sparse). Never throws — a lookup blip degrades to null.
   */
  lookupLicence: (song: {
    abs: string;
    artist: string;
    title: string;
  }) => Promise<LicenceLookupResult | null>;
  /** Returns a Spotify portrait url for an artist name, or null. Null when Spotify
   *  isn't configured — the artist-image task then relies on Lidarr alone. */
  lookupArtistImageSpotify: ((name: string) => Promise<string | null>) | null;
  /** Resolve Discogs bio/links for an artist's MBID (issue #195), or null when
   *  unavailable/no confident match. Null *member* (not just a null return)
   *  when no artist-info-capable plugin is enabled+configured — the task then
   *  reports itself unavailable. */
  lookupArtistInfo: ((mbid: string) => Promise<ArtistInfoResult | null>) | null;
  /** Resolve a compound artist string to a split decision via Lidarr/MB. Null when
   *  Lidarr isn't configured (the `artist-identity` task is then unavailable and the
   *  scanner falls back to library-only atomic confirmation). */
  resolveArtistIdentity:
    ((rawName: string, parts: string[]) => Promise<ArtistIdentityDecision>) | null;
  fileExists: (abs: string) => boolean;
}

/** A resolved split decision for one compound artist string. */
export interface ArtistIdentityDecision {
  /** 'single' → one act (keep whole); 'split' → real collab; 'unknown' → no opinion. */
  decision: 'single' | 'split' | 'unknown';
  /** Raw member names (tag spelling) when `decision === 'split'`; else empty. */
  members: string[];
}

/** True if any Lidarr lookup hit is an exact normalized-name match for `name` —
 *  the discipline that avoids the same-name-different-artist hazard (the real
 *  "Emilia"/"Âme" false pairs) by never accepting a fuzzy/best-guess pick. */
function exactNameMatch(hits: readonly LidarrArtist[], name: string): boolean {
  const want = normalizeArtistForGrouping(name);
  return hits.some((a) => normalizeArtistForGrouping(a.artistName) === want);
}

/**
 * Build a Lidarr-backed resolver for compound artist strings. Memoizes per-name
 * lookups for the lifetime of the context (one window run) so compounds sharing a
 * member don't re-query. Every Lidarr call is guarded — a blip degrades to 'unknown',
 * never throws, so one bad name can't abort the batch.
 */
export function makeLidarrArtistIdentityResolver(
  lidarr: Lidarr,
): (rawName: string, parts: string[]) => Promise<ArtistIdentityDecision> {
  const memo = new Map<string, LidarrArtist[]>();
  const lookup = async (term: string): Promise<LidarrArtist[]> => {
    const key = normalizeArtistForGrouping(term);
    const cached = memo.get(key);
    if (cached) return cached;
    let hits: LidarrArtist[];
    try {
      hits = await lidarr.artist.lookup(term);
    } catch {
      hits = [];
    }
    memo.set(key, hits);
    return hits;
  };

  return async (rawName, parts) => {
    // 1. Is the whole compound itself a canonical artist (band/duo)? Keep it whole.
    if (exactNameMatch(await lookup(rawName), rawName)) return { decision: 'single', members: [] };
    // 2. Does every part resolve to a real artist? Then it's a genuine collab.
    if (parts.length > 1) {
      for (const part of parts) {
        if (!exactNameMatch(await lookup(part), part)) return { decision: 'unknown', members: [] };
      }
      return { decision: 'split', members: parts };
    }
    return { decision: 'unknown', members: [] };
  };
}

/**
 * Resolve a name to an MBID via a single exact-match Lidarr lookup, or null
 * (issue #207 — artist-info's only prior MBID source, `library_mbids`, is
 * never populated automatically for artists in production). Never throws — a
 * lookup blip degrades to null, same as the identity resolver above.
 */
async function resolveMbidViaLidarr(lidarr: Lidarr, name: string): Promise<string | null> {
  let hits: LidarrArtist[];
  try {
    hits = await lidarr.artist.lookup(name);
  } catch {
    return null;
  }
  const want = normalizeArtistForGrouping(name);
  const hit = hits.find((a) => normalizeArtistForGrouping(a.artistName) === want);
  return hit ? hit.foreignArtistId : null;
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
  /**
   * SQL predicate (against a bare `library_songs` row) that is true once this task
   * has produced its value for a song — the inverse of `countPending`'s NULL test.
   * Present only on *per-song* tasks that can gate landing; absent (e.g.
   * `artist-image`, which is per-artist) means the task can never be a landing
   * gate. Used by the graduation predicate to decide when a quarantined song may
   * be added to the library.
   */
  satisfiedColumnSql?: string;
}

/** Build a context wired to the real primitives. */
export function createEnrichmentContext(deps: {
  musicDir: string;
  coverCacheDir: string;
  lidarr: Lidarr | null;
  concurrency: number;
  /** Spotify portrait lookup, or null when Spotify creds aren't configured. */
  lookupArtistImageSpotify?: ((name: string) => Promise<string | null>) | null;
  /** Discogs artist bio/links lookup, or null when unconfigured. */
  lookupArtistInfo?: ((mbid: string) => Promise<ArtistInfoResult | null>) | null;
  /** Sidecar client, or null when NICOTIND_ANALYSIS_URL isn't configured. */
  audioFeaturesClient?: AudioFeaturesClient | null;
  /** Data dir — locates the MusicBrainz cache file for licence lookups. */
  dataDir?: string;
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
      // Full Lidarr genre list (best-first, ';'-joined) so the fill populates
      // the whole set, not just a primary; fall back to the single suggestion.
      return r.candidates.length > 0 ? r.candidates.join('; ') : r.suggested;
    },
    lookupArtistImageSpotify: deps.lookupArtistImageSpotify ?? null,
    lookupArtistInfo: deps.lookupArtistInfo ?? null,
    resolveArtistIdentity: deps.lidarr ? makeLidarrArtistIdentityResolver(deps.lidarr) : null,
    lookupLicence: makeLicenceLookup(deps.dataDir ?? null),
    fileExists: (abs) => existsSync(abs),
  };
}

/**
 * Build a licence resolver: the file's own LICENSE/COPYRIGHT tag first (zero
 * network), then a MusicBrainz `license` url-relation (best-effort, only when a
 * dataDir is available to cache MB responses). The MB client is created once per
 * context so its 1-req/sec rate limit + on-disk cache are shared across a run.
 */
function makeLicenceLookup(
  dataDir: string | null,
): (song: { abs: string; artist: string; title: string }) => Promise<LicenceLookupResult | null> {
  const mb = dataDir
    ? new MusicBrainzClient(join(dataDir, 'musicbrainz-cache.json'), MB_USER_AGENT)
    : null;
  return async (song) => {
    const tags = await readAudioTags(song.abs).catch(() => null);
    if (tags?.licence) return { code: tags.licence, source: 'tag' };
    if (!mb) return null;
    const code = await mb
      .getLicence({
        mbRecordingId: tags?.mbRecordingId,
        mbReleaseId: tags?.mbReleaseId,
        artist: song.artist,
        title: song.title,
      })
      .catch(() => null);
    return code ? { code, source: 'musicbrainz' } : null;
  };
}

const bpmTask: EnrichmentTask = {
  id: 'bpm',
  label: 'BPM analysis',
  satisfiedColumnSql: 'bpm IS NOT NULL',
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
  satisfiedColumnSql: "(genre IS NOT NULL AND genre != '')",
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
      // a.genre may be a ';'-joined list (full Lidarr set, best-first): write
      // the whole set to the join table + primary mirror, and the joined form
      // to the file tag.
      const genres = a.genre
        .split(/[;,|]/)
        .map((g) => g.trim().replace(/\s+/g, ' '))
        .filter(Boolean);
      // Append, never override — a song that already carries tag genres keeps them
      // and gains Lidarr's. (The pending set is empty-genre songs, so in practice
      // this appends onto nothing; the union still guards against clobbering.)
      const merged = appendSongGenres(db, a.song.id, genres);
      const abs = resolveSongAbsPath(ctx.musicDir, a.song.path);
      if (ctx.fileExists(abs))
        await ctx.writeTags(abs, { genre: merged.join('; ') }).catch(() => false);
      applied++;
      labels.push(`${a.song.artist} — ${a.song.title} → ${merged.join('; ')}`);
    }
    return { applied, labels, failed: 0, errorSample: null };
  },
};

const keyTask: EnrichmentTask = {
  id: 'key',
  label: 'Musical key',
  satisfiedColumnSql: "(key IS NOT NULL AND key != '')",
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
  satisfiedColumnSql: 'energy IS NOT NULL',
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
  // `danceability` is written in the same tx as the other feature columns, so a
  // non-null danceability means the whole sidecar feature set landed for the song.
  satisfiedColumnSql: 'danceability IS NOT NULL',
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
    configuredArtistImageSources({
      lidarr: ctx.lidarr,
      spotifyLookup: ctx.lookupArtistImageSpotify,
    }).length > 0
      ? true
      : 'No artist-image provider configured',
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

    // The priority-ordered provider chain, assembled once per batch and reused
    // across rows (Lidarr provider closes over the shared `index`).
    const providers = buildArtistImageProviders({
      db,
      lidarr: ctx.lidarr,
      index,
      spotifyLookup: ctx.lookupArtistImageSpotify,
    });

    const labels: string[] = [];
    let applied = 0;
    for (const artist of rows) {
      if (isPlaceholderArtist(artist.name)) continue;
      const resolved = await resolveArtistImageUrl(providers, artist);
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

interface ArtistNameRow {
  id: string;
  name: string;
}

/**
 * Backfill artist bios + external links from Discogs (issue #195), MBID-first
 * via MusicBrainz's `discogs` url-relation (see musicbrainz-client.ts,
 * services/plugins/discogs/index.ts). Per-artist like {@link artistImageTask},
 * never a landing gate. Presence of a `library_artist_meta` row — even a
 * tombstone (bio=NULL) written for a confident miss — is what keeps the task
 * from re-querying every window; skips `manual_override=1` rows entirely
 * (they already have a meta row, so the NOT EXISTS predicate excludes them).
 */
const artistInfoTask: EnrichmentTask = {
  id: 'artist-info',
  label: 'Artist bios',
  available: (ctx) => (ctx.lookupArtistInfo ? true : 'No artist-info provider configured'),
  countPending: (db) =>
    Number(
      (
        db
          .query<{ n: number }, []>(
            `SELECT COUNT(*) AS n FROM library_artists a
             WHERE a.hidden = 0
               AND NOT EXISTS (SELECT 1 FROM library_artist_meta m WHERE m.artist_id = a.id)`,
          )
          .get() ?? { n: 0 }
      ).n,
    ),
  run: async (db, ctx, limit) => {
    if (!ctx.lookupArtistInfo) return { applied: 0, labels: [], failed: 0, errorSample: null };
    const rows = db
      .query<ArtistNameRow, [number]>(
        `SELECT id, name FROM library_artists a
         WHERE a.hidden = 0
           AND NOT EXISTS (SELECT 1 FROM library_artist_meta m WHERE m.artist_id = a.id)
         ORDER BY a.album_count DESC, a.name LIMIT ?`,
      )
      .all(limit);

    const labels: string[] = [];
    const tally: FailureTally = { failed: 0, sample: null };
    let applied = 0;
    for (const artist of rows) {
      const mbidRow = getMbid(db, 'artist', normalizeArtistForGrouping(artist.name));
      let mbid = mbidRow?.mbid ?? null;
      // Fallback (issue #207): library_mbids is never populated for artists
      // automatically in production, so a cache miss is resolved live via a
      // single exact-match Lidarr lookup and persisted, rather than tombstoned
      // immediately. Once written, every later window hits the cache above.
      if (!mbid && ctx.lidarr) {
        mbid = await resolveMbidViaLidarr(ctx.lidarr, artist.name);
        if (mbid) {
          upsertMbid(db, {
            scope: 'artist',
            key: normalizeArtistForGrouping(artist.name),
            mbid,
            source: 'lidarr',
            confidence: 0.8,
          });
        }
      }
      if (!mbid) {
        upsertArtistMeta(db, { artistId: artist.id, bio: null, urls: [], source: 'discogs' });
        continue;
      }
      try {
        const info = await ctx.lookupArtistInfo(mbid);
        if (!info) {
          upsertArtistMeta(db, { artistId: artist.id, bio: null, urls: [], source: 'discogs' });
          continue;
        }
        upsertArtistMeta(db, {
          artistId: artist.id,
          bio: info.bio,
          urls: info.urls,
          source: info.source,
        });
        applied++;
        labels.push(
          `${artist.name} → bio${info.urls.length ? ` + ${info.urls.length} link(s)` : ''}`,
        );
      } catch (err) {
        recordFailure(tally, err);
      }
    }
    return { applied, labels, failed: tally.failed, errorSample: tally.sample };
  },
};

/**
 * SQL predicate (against the alias `name`) selecting compound artist strings that
 * *might* be splittable — a cheap superset of {@link splitOnDelimiters}. False
 * positives (e.g. a stray ` x ` inside a word) simply resolve to 'unknown' and drop
 * out, so a permissive match is fine.
 */
const DELIMITED_ARTIST_SQL = `(
  name LIKE '% & %' OR name LIKE '%, %' OR name LIKE '% / %' OR name LIKE '% + %'
  OR name LIKE '% and %' OR name LIKE '% y %' OR name LIKE '% x %' OR name LIKE '% con %'
  OR name LIKE '% vs %' OR name LIKE '% vs. %'
)`;

/** Re-resolve a compound's identity at most this often. */
export const ARTIST_IDENTITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Distinct delimited artist/album-artist strings lacking a fresh authority row. */
export function pendingArtistIdentityRows(db: Database, cutoff: number, limit?: number): string[] {
  const rows = db
    .query<{ name: string }, [number] | [number, number]>(
      `SELECT name FROM (
         SELECT DISTINCT artist AS name FROM library_songs WHERE artist IS NOT NULL
         UNION
         SELECT DISTINCT album_artist AS name FROM library_songs WHERE album_artist IS NOT NULL
       ) t
       WHERE ${DELIMITED_ARTIST_SQL}
         AND NOT EXISTS (
           SELECT 1 FROM library_artist_identity i
           WHERE i.raw_name = t.name AND (i.checked_at > ? OR i.source = 'user')
         )
       ORDER BY name${limit != null ? ' LIMIT ?' : ''}`,
    )
    .all(...((limit != null ? [cutoff, limit] : [cutoff]) as [number] | [number, number]));
  return rows.map((r) => r.name);
}

/**
 * Resolve compound artist strings (e.g. "Bob Marley & The Wailers" vs
 * "Bob Marley, Peter Tosh") into a cached split decision the *synchronous* scanner
 * reads — so multi-artist splitting never makes a live network call. Per-artist (like
 * {@link artistImageTask}), so it is never a landing gate. Records a row for every
 * attempted compound (incl. 'unknown') so an unresolvable name drops out of the
 * pending set until the TTL lapses, instead of being re-queried every window.
 */
const artistIdentityTask: EnrichmentTask = {
  id: 'artist-identity',
  label: 'Artist identity',
  available: (ctx) => (ctx.resolveArtistIdentity ? true : 'Lidarr not configured'),
  countPending: (db) => pendingArtistIdentityRows(db, Date.now() - ARTIST_IDENTITY_TTL_MS).length,
  run: async (db, ctx, limit) => {
    if (!ctx.resolveArtistIdentity) return { applied: 0, labels: [], failed: 0, errorSample: null };
    const names = pendingArtistIdentityRows(db, Date.now() - ARTIST_IDENTITY_TTL_MS, limit);
    const labels: string[] = [];
    const tally: FailureTally = { failed: 0, sample: null };
    let applied = 0;
    for (const name of names) {
      const parts = splitOnDelimiters(name);
      try {
        const { decision, members } = await ctx.resolveArtistIdentity(name, parts);
        upsertArtistIdentity(db, {
          artistKey: artistIdFor(name),
          rawName: name,
          decision,
          members,
          source: 'lidarr',
        });
        applied++;
        if (decision === 'split') labels.push(`${name} → ${members.join(' + ')}`);
        else if (decision === 'single') labels.push(`${name} (one act)`);
      } catch (err) {
        recordFailure(tally, err);
      }
    }
    // NOTE: no unattended alias derivation here — deriveMbidAliases proposals need
    // human review (the MBID cache holds fuzzy top-hit lookups; see its docblock).
    return { applied, labels, failed: tally.failed, errorSample: tally.sample };
  },
};

/**
 * Rights/licence fill: the file's own LICENSE/COPYRIGHT tag first (zero network),
 * then a MusicBrainz `license` url-relation. Always available (tag reads need
 * nothing; MB is a bonus). Never a landing gate — an optional/uncertain source
 * must not strand a fresh download. A confident "no licence found" is ledgered
 * via NoConfidentResultError (drops out of the queue, NOT tallied as a failure —
 * nothing is broken, MB simply has no data), exactly like unresolvable genre.
 */
const licenceTask: EnrichmentTask = {
  id: 'licence',
  label: 'Licence / rights',
  satisfiedColumnSql: 'licence IS NOT NULL',
  available: () => true,
  countPending: (db) =>
    Number(
      (
        db
          .query<{ n: number }, []>(
            `SELECT COUNT(*) AS n FROM library_songs WHERE licence IS NULL${notPermanentlyFailedClause(
              'licence',
            )}`,
          )
          .get() ?? { n: 0 }
      ).n,
    ),
  run: async (db, ctx, limit) => {
    const rows = db
      .query<SongRow, [number]>(
        `SELECT id, path, artist, title, size FROM library_songs WHERE licence IS NULL${notPermanentlyFailedClause(
          'licence',
        )} ORDER BY created DESC LIMIT ?`,
      )
      .all(limit);

    const labels: string[] = [];
    const tally: FailureTally = { failed: 0, sample: null };
    let applied = 0;
    for (const song of rows) {
      const abs = resolveSongAbsPath(ctx.musicDir, song.path);
      if (!ctx.fileExists(abs)) continue;
      try {
        const res = await ctx.lookupLicence({ abs, artist: song.artist, title: song.title });
        if (!res) {
          noteItemFailure(
            db,
            tally,
            song,
            'licence',
            new NoConfidentResultError('no licence found'),
          );
          continue;
        }
        db.run('UPDATE library_songs SET licence = ?, licence_source = ? WHERE id = ?', [
          res.code,
          res.source,
          song.id,
        ]);
        // Mirror to the file tag so a rescan reads it back. A 'tag' source already
        // carries it, but the write is idempotent; an 'musicbrainz' source needs it.
        await ctx.writeTags(abs, { licence: res.code }).catch(() => false);
        clearAnalysisFailure(db, song.id, 'licence');
        applied++;
        labels.push(`${song.artist} — ${song.title} → ${res.code}`);
      } catch (err) {
        noteItemFailure(db, tally, song, 'licence', err);
      }
    }
    return { applied, labels, failed: tally.failed, errorSample: tally.sample };
  },
};

/**
 * Top-1 softmax probability below which a genre_discogs400 inference is
 * ledgered-not-written (issue #187 task A2). Operator-tunable via env var
 * (like other sidecar knobs, e.g. NICOTIND_ANALYSIS_URL) rather than a
 * ProcessingSettings field — this is a classifier-quality knob, not a
 * structural toggle, and the right value is genuinely an open question this
 * PR can't fully settle until real confidence data comes in from a deployed
 * sidecar. 0.5 is a conservative starting default for a 400-way classifier.
 */
export const GENRE_AUDIO_CONFIDENCE_THRESHOLD = Number(
  process.env.NICOTIND_GENRE_AUDIO_CONFIDENCE ?? 0.5,
);

/**
 * `genreTask` has already tried and ledgered this song as unresolved. Required
 * so the fallback can never win a race against the authoritative MusicBrainz/
 * Lidarr source for a song genreTask simply hasn't gotten to yet — both tasks
 * share the same `created DESC` ordering and a `genre IS NULL` predicate, so
 * without this an audio-only guess could permanently pre-empt a real genre
 * (writing a genre clears `library_songs.genre`, removing the song from
 * genreTask's pending set for good). A Lidarr-less install never populates
 * this ledger, so genre-audio simply never fires there — an accepted
 * limitation, since audio inference is fallback-only, not a primary source.
 */
const GENRE_AUDIO_LEDGER_CLAUSE =
  ` AND EXISTS (SELECT 1 FROM library_song_analysis_failures f` +
  ` WHERE f.song_id = library_songs.id AND f.task = 'genre')`;

/**
 * Audio-inferred genre fallback (issue #187 task A2) — the sidecar's
 * genre_discogs400 head, strictly below tag/MusicBrainz/Lidarr genre and only
 * ever consulted once `genreTask` has given up (see
 * {@link GENRE_AUDIO_LEDGER_CLAUSE}). Deliberately weak on regional genres
 * (Chamamé/Argentine folclore) — a low-confidence result is ledgered via
 * {@link NoConfidentResultError}, never force-written. A confident hit is
 * written via the provenance-tagged `library_genre_overrides` path
 * (`source: 'essentia'`), never `appendSongGenres` — this is the first real
 * writer of that reserved source. Never a landing gate (no
 * `satisfiedColumnSql`): a weak classifier must never strand a download.
 */
const genreAudioTask: EnrichmentTask = {
  id: 'genre-audio',
  label: 'Genre (audio fallback)',
  available: (ctx) => {
    if (!ctx.analyzeAudioFeatures) return 'analysis sidecar not configured';
    return ctx.audioFeaturesAvailable() ? true : 'analysis sidecar unreachable';
  },
  countPending: (db) =>
    Number(
      (
        db
          .query<{ n: number }, []>(
            `SELECT COUNT(*) AS n FROM library_songs WHERE (genre IS NULL OR genre = '')${GENRE_AUDIO_LEDGER_CLAUSE}${notPermanentlyFailedClause(
              'genre-audio',
            )}`,
          )
          .get() ?? { n: 0 }
      ).n,
    ),
  run: async (db, ctx, limit) => {
    const rows = db
      .query<SongRow, [number]>(
        `SELECT id, path, artist, title, size FROM library_songs WHERE (genre IS NULL OR genre = '')${GENRE_AUDIO_LEDGER_CLAUSE}${notPermanentlyFailedClause(
          'genre-audio',
        )} ORDER BY created DESC LIMIT ?`,
      )
      .all(limit);

    const labels: string[] = [];
    const tally: FailureTally = { failed: 0, sample: null };
    let applied = 0;
    let cursor = 0;
    // Mirrors audioFeaturesTask: the sidecar serializes inference internally,
    // so more than 2 in flight only queues.
    const worker = async (): Promise<void> => {
      for (;;) {
        const idx = cursor++;
        if (idx >= rows.length) return;
        const song = rows[idx]!;
        const abs = resolveSongAbsPath(ctx.musicDir, song.path);
        if (!ctx.fileExists(abs)) continue;
        if (!ctx.analyzeAudioFeatures) return;

        let result: AudioFeaturesResult | null = null;
        try {
          result = await ctx.analyzeAudioFeatures(song.path);
        } catch (err) {
          if (err instanceof AudioFileRejectedError) {
            noteItemFailure(db, tally, song, 'genre-audio', err);
          } else {
            if (!ctx.audioFeaturesAvailable()) return;
            recordFailure(tally, err instanceof Error ? err : new Error(String(err)));
          }
          continue;
        }
        if (!result) {
          // Sidecar gone mid-batch — an outage, not a per-file condition.
          if (!ctx.audioFeaturesAvailable()) return;
          recordFailure(tally, new Error('analysis sidecar could not analyze file (see logs)'));
          continue;
        }
        if (!result.genre) {
          // Sidecar build predates the genre head — "ran, found nothing",
          // ledgered so it isn't retried forever, but nothing is broken.
          noteItemFailure(
            db,
            tally,
            song,
            'genre-audio',
            new NoConfidentResultError('sidecar has no genre head'),
          );
          continue;
        }
        if (result.genre.confidence < GENRE_AUDIO_CONFIDENCE_THRESHOLD) {
          noteItemFailure(
            db,
            tally,
            song,
            'genre-audio',
            new NoConfidentResultError(
              `genre confidence ${result.genre.confidence.toFixed(2)} below threshold`,
            ),
          );
          continue;
        }

        const written = upsertGenreOverride(db, {
          scope: 'song',
          key: song.id,
          genres: [result.genre.label],
          source: 'essentia',
          mbid: null,
          confidence: result.genre.confidence,
          status: 'applied',
          note: result.genre.style,
        });
        if (!written) continue; // an existing user override is permanent — leave it alone

        const existingGenres = db
          .query<{ genre: string }, [string]>(
            `SELECT genre FROM library_song_genres WHERE song_id = ? ORDER BY position`,
          )
          .all(song.id)
          .map((g) => g.genre);
        const overrideIdx: OverrideIndex = {
          artist: new Map(),
          album: new Map(),
          song: new Map([[song.id, { genres: [result.genre.label], source: 'essentia' }]]),
        };
        const merged = applyGenreOverride(
          overrideIdx,
          { songId: song.id, albumKey: '', artistKey: '' },
          existingGenres,
        );
        setSongGenres(db, song.id, merged);
        await ctx.writeTags(abs, { genre: merged.join('; ') }).catch(() => false);
        clearAnalysisFailure(db, song.id, 'genre-audio');
        applied++;
        labels.push(`${song.artist} — ${song.title} → ${result.genre.label} (audio)`);
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(ctx.concurrency, 2)) }, () => worker()),
    );
    return { applied, labels, failed: tally.failed, errorSample: tally.sample };
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
  artistInfoTask,
  artistIdentityTask,
  licenceTask,
  genreAudioTask,
];

export function getTask(id: ProcessingTaskId): EnrichmentTask | undefined {
  return ENRICHMENT_TASKS.find((t) => t.id === id);
}
