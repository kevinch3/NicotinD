import type { Database } from 'bun:sqlite';
import { join } from 'node:path';
import type { IdentifyOutcome, MetadataCandidate } from '@nicotind/core';
import { createLogger, stripTitleQualifiers } from '@nicotind/core';
import type { FixLidarr } from './metadata-fix.js';
import { scoreCandidate, rankCandidates, parseYear } from './metadata-fix.js';
import { isPlaceholderArtist } from './artwork-backfill.js';
import { mapLidarrAlbumType } from './release-meta-store.js';
import type { MusicBrainzClient } from './musicbrainz-client.js';
import type { PluginRegistry } from './plugins/registry.js';
import { readAudioTags } from './audio-tags.js';
import { fold } from './search-tokens.js';
import { computeIdentifyAvailable, identifyOne, identifyPlugin } from './identify.js';
import { cleanDisplayTitle } from './title-clean.js';

const log = createLogger('candidate-sources');

const DEFAULT_TIMEOUT_MS = 4000;
const MAX_CANDIDATES = 12;

export type CandidateSourceId = 'lidarr' | 'musicbrainz' | 'discogs' | 'tags';

export interface CandidateSourcesDeps {
  db: Database;
  /** Lidarr client, null/absent when unconfigured — the lidarr source is omitted. */
  lidarr?: FixLidarr | null;
  /** MusicBrainz client, null/absent when unconfigured — the mb source is omitted. */
  mb?: MusicBrainzClient | null;
  /** Plugin registry, used to resolve a `release-candidates` (Discogs) source
   *  and the `identify` (AcoustID) availability flag. */
  plugins?: PluginRegistry | null;
  /** Music dir root — enables the tags source (reads the album's first song's
   *  file tags directly, the offline/no-network fallback). */
  musicDir?: string;
  /** Per-source timeout; a slow source degrades to `ok:false` rather than
   *  blocking the whole gather. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to the real file-tag reader. */
  readTags?: typeof readAudioTags;
}

export interface GatherResult {
  album: { id: string; name: string; artist: string };
  query: string;
  candidates: MetadataCandidate[];
  sources: Array<{ id: CandidateSourceId; ok: boolean }>;
  /** Whether an enabled+configured `identify` (fingerprint) plugin exists. */
  identifyAvailable: boolean;
}

interface AlbumRow {
  id: string;
  name: string;
  artist: string;
}

/** Race a promise against a timeout, rejecting if `ms` elapses first. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

interface SourceOutcome<Id extends string = CandidateSourceId> {
  id: Id;
  ok: boolean;
  candidates: MetadataCandidate[];
}

/**
 * Run one source under the shared timeout, normalizing both a thrown error and
 * a timeout into `ok:false` + no candidates — a single flaky/slow source must
 * never fail the whole gather (the other sources still get to contribute).
 */
function runSource<Id extends string>(
  id: Id,
  timeoutMs: number,
  fn: () => Promise<MetadataCandidate[]>,
): Promise<SourceOutcome<Id>> {
  return withTimeout(fn(), timeoutMs)
    .then((candidates) => ({ id, ok: true, candidates }))
    .catch((err: unknown) => {
      log.warn({ err, id }, 'metadata candidate source failed');
      return { id, ok: false, candidates: [] };
    });
}

/** Fold `artist|title|year` into a dedupe key (accent/case-insensitive). */
function dedupeKey(c: MetadataCandidate): string {
  return `${fold(c.artist)}|${fold(c.title)}|${c.year ?? ''}`;
}

/**
 * Dedupe by (artist,title,year), keeping the higher-scored duplicate, then
 * sort desc by score. Pure — unit-tested via `gatherCandidates`.
 */
function dedupeAndRank(candidates: MetadataCandidate[]): MetadataCandidate[] {
  const best = new Map<string, MetadataCandidate>();
  for (const c of candidates) {
    const key = dedupeKey(c);
    const existing = best.get(key);
    if (!existing || c.score > existing.score) best.set(key, c);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

/**
 * Resolve a song's DB-stored path to an absolute filesystem path. Mirrors
 * `routes/library.ts`'s private `resolveSongPath`, minus the music-dir
 * containment check that route needs for a user-suppliable path — here the
 * path always comes from `library_songs`, which the scanner already
 * constrained to the music dir.
 */
function absoluteSongPath(musicDir: string, songPath: string): string {
  return songPath.startsWith('/') ? songPath : join(musicDir, songPath);
}

export type SongCandidateSourceId = CandidateSourceId | 'acoustid';

export interface SongGatherResult {
  song: { id: string; title: string; artist: string; album: string | null; albumId: string };
  query: string;
  /** `cleanDisplayTitle` over title + album name; null when nothing was stripped. */
  suggested: { title: string; album: string | null; removed: string[] } | null;
  candidates: MetadataCandidate[];
  sources: Array<{ id: SongCandidateSourceId; ok: boolean }>;
  identifyAvailable: boolean;
  /** Typed fingerprint outcome when the acoustid source ran; absent when skipped. */
  identify?: IdentifyOutcome;
}

interface SongRow {
  id: string;
  title: string;
  artist: string;
  albumId: string;
  album: string | null;
  path: string;
}

// fpcalc decode + the AcoustID round-trip routinely exceed the 4s source
// budget, so the fingerprint source gets its own generous bound instead.
const ACOUSTID_TIMEOUT_MS = 20_000;

/**
 * Song-scoped sibling of `gatherCandidates` for the YouTube-pollution curator
 * flow (issue #722): "where does this track really belong, and what is it
 * really called?". Candidates are ALBUM candidates for the song; the
 * MusicBrainz source uses the recording search (track title → best Official
 * release), and an optional AcoustID fingerprint contributes both the typed
 * outcome and a candidate. The `suggested` field carries the display-safe
 * cleaner's opinion so callers get an offline answer even with zero sources.
 */
export async function gatherSongCandidates(
  deps: CandidateSourcesDeps,
  songId: string,
  query?: string,
  opts?: { fingerprint?: boolean },
): Promise<SongGatherResult | null> {
  const { db, lidarr, mb, plugins, musicDir, timeoutMs = DEFAULT_TIMEOUT_MS } = deps;
  const readTags = deps.readTags ?? readAudioTags;

  const song = db
    .query<SongRow, [string]>(
      `SELECT s.id, s.title, s.artist, s.album_id AS albumId, a.name AS album, s.path
       FROM library_songs s LEFT JOIN library_albums a ON a.id = s.album_id
       WHERE s.id = ?`,
    )
    .get(songId);
  if (!song) return null;

  const titleClean = cleanDisplayTitle(song.title);
  const albumClean = song.album ? cleanDisplayTitle(song.album) : null;
  const removed = [...new Set([...titleClean.removed, ...(albumClean?.removed ?? [])])];
  const suggested =
    removed.length > 0
      ? { title: titleClean.cleaned, album: albumClean?.cleaned ?? null, removed }
      : null;

  const strippedTitle = stripTitleQualifiers(song.title);
  const artistPart = isPlaceholderArtist(song.artist) ? '' : song.artist;
  const q = (query ?? `${artistPart} ${strippedTitle}`).trim();

  const jobs: Array<Promise<SourceOutcome<SongCandidateSourceId>>> = [];

  if (lidarr) {
    jobs.push(
      runSource<SongCandidateSourceId>('lidarr', timeoutMs, async () => {
        const hits = await lidarr.album.lookup(q);
        return rankCandidates(hits, q, hits.length).map((c) => ({
          ...c,
          source: 'lidarr' as const,
        }));
      }),
    );
  }

  if (mb) {
    jobs.push(
      runSource<SongCandidateSourceId>('musicbrainz', timeoutMs, async () => {
        const rec = await mb.searchRecording(song.artist, strippedTitle);
        if (!rec?.release) return [];
        return [
          {
            releaseGroupId: null,
            artist: song.artist,
            title: rec.release.title,
            year: parseYear(rec.release.date),
            releaseType: mapLidarrAlbumType(rec.release.primaryType),
            coverUrl: null,
            // MB's own 0-100 score: how well the recording matched artist+title.
            score: rec.score,
            source: 'musicbrainz' as const,
          },
        ];
      }),
    );
  }

  const discogsPlugins = plugins?.getEnabledWithCapability('release-candidates') ?? [];
  if (discogsPlugins.length > 0) {
    jobs.push(
      runSource<SongCandidateSourceId>('discogs', timeoutMs, async () => {
        const perPlugin = await Promise.all(
          discogsPlugins.map((p) =>
            p.releaseCandidates
              ? p.releaseCandidates.searchReleases({ artist: song.artist, album: strippedTitle })
              : Promise.resolve([]),
          ),
        );
        return perPlugin.flat().map((h) => ({
          releaseGroupId: null,
          artist: h.artist,
          title: h.title,
          year: h.year,
          releaseType: null,
          coverUrl: h.coverUrl,
          score: Math.round(h.confidence * 100),
          source: 'discogs' as const,
        }));
      }),
    );
  }

  if (musicDir) {
    jobs.push(
      runSource<SongCandidateSourceId>('tags', timeoutMs, async () => {
        const tags = await readTags(absoluteSongPath(musicDir, song.path));
        const artist = tags.albumArtist ?? tags.artist;
        const title = tags.album;
        if (!artist && !title) return [];
        return [
          {
            releaseGroupId: null,
            artist: artist ?? '',
            title: title ?? '',
            year: tags.year ?? null,
            releaseType: null,
            coverUrl: null,
            score: scoreCandidate(q, artist ?? '', title ?? ''),
            source: 'tags' as const,
          },
        ];
      }),
    );
  }

  let identify: IdentifyOutcome | undefined;
  const idPlugin = opts?.fingerprint === false ? null : identifyPlugin(plugins);
  if (idPlugin && musicDir) {
    jobs.push(
      runSource<SongCandidateSourceId>('acoustid', ACOUSTID_TIMEOUT_MS, async () => {
        const outcome = await identifyOne(idPlugin, absoluteSongPath(musicDir, song.path));
        identify = outcome;
        if (outcome.kind !== 'match' || !outcome.result.album) return [];
        const r = outcome.result;
        return [
          {
            releaseGroupId: null,
            artist: r.artist ?? song.artist,
            title: r.album ?? '',
            year: r.year ?? null,
            releaseType: null,
            coverUrl: null,
            score: Math.round(r.score * 100),
            source: 'acoustid' as const,
          },
        ];
      }),
    );
  }

  const outcomes = await Promise.allSettled(jobs);
  const sources: SongGatherResult['sources'] = [];
  const all: MetadataCandidate[] = [];
  for (const o of outcomes) {
    if (o.status !== 'fulfilled') continue;
    sources.push({ id: o.value.id, ok: o.value.ok });
    all.push(...o.value.candidates);
  }

  return {
    song: {
      id: song.id,
      title: song.title,
      artist: song.artist,
      album: song.album,
      albumId: song.albumId,
    },
    query: q,
    suggested,
    candidates: dedupeAndRank(all).slice(0, MAX_CANDIDATES),
    sources,
    identifyAvailable: computeIdentifyAvailable(plugins),
    identify,
  };
}

/**
 * Multi-source metadata candidate gatherer for the download-inbox triage flow
 * (issue #411) and the pre-existing Fix-metadata modal. Runs every configured
 * source (Lidarr lookup, MusicBrainz release-group search, Discogs via its
 * `release-candidates` capability, and a network-free read of the album's own
 * file tags) in parallel, each bounded by `timeoutMs` — a down/slow/
 * unconfigured source degrades to `{ ok: false }` (or is omitted entirely when
 * not configured) rather than failing the whole request, so triage never blocks
 * on any one dependency. Results are merged, deduped by (artist,title,year),
 * ranked by score, and capped so the picker stays scannable.
 */
export async function gatherCandidates(
  deps: CandidateSourcesDeps,
  albumId: string,
  query?: string,
): Promise<GatherResult | null> {
  const { db, lidarr, mb, plugins, musicDir, timeoutMs = DEFAULT_TIMEOUT_MS } = deps;
  const readTags = deps.readTags ?? readAudioTags;

  const album = db
    .query<AlbumRow, [string]>('SELECT id, name, artist FROM library_albums WHERE id = ?')
    .get(albumId);
  if (!album) return null;

  // A placeholder artist ("<Desconocido>") poisons the default query — fall
  // back to an album-title-only search, mirroring searchCandidates.
  const fallback = isPlaceholderArtist(album.artist) ? album.name : `${album.artist} ${album.name}`;
  const q = (query ?? fallback).trim();

  const jobs: Array<Promise<SourceOutcome>> = [];

  if (lidarr) {
    jobs.push(
      runSource('lidarr', timeoutMs, async () => {
        const hits = await lidarr.album.lookup(q);
        return rankCandidates(hits, q, hits.length).map((c) => ({
          ...c,
          source: 'lidarr' as const,
        }));
      }),
    );
  }

  if (mb) {
    jobs.push(
      runSource('musicbrainz', timeoutMs, async () => {
        const artistPart = isPlaceholderArtist(album.artist) ? '' : album.artist;
        const hits = await mb.searchReleaseGroups(artistPart, album.name);
        return hits.map((h) => ({
          releaseGroupId: h.id,
          artist: h.artist,
          title: h.title,
          year: parseYear(h.firstReleaseDate),
          releaseType: mapLidarrAlbumType(h.primaryType),
          coverUrl: null,
          score: scoreCandidate(q, h.artist, h.title),
          source: 'musicbrainz' as const,
        }));
      }),
    );
  }

  const discogsPlugins = plugins?.getEnabledWithCapability('release-candidates') ?? [];
  if (discogsPlugins.length > 0) {
    jobs.push(
      runSource('discogs', timeoutMs, async () => {
        const perPlugin = await Promise.all(
          discogsPlugins.map((p) =>
            p.releaseCandidates
              ? p.releaseCandidates.searchReleases({ artist: album.artist, album: album.name })
              : Promise.resolve([]),
          ),
        );
        return perPlugin.flat().map((h) => ({
          releaseGroupId: null,
          artist: h.artist,
          title: h.title,
          year: h.year,
          releaseType: null,
          coverUrl: h.coverUrl,
          score: Math.round(h.confidence * 100),
          source: 'discogs' as const,
        }));
      }),
    );
  }

  if (musicDir) {
    jobs.push(
      runSource('tags', timeoutMs, async () => {
        const song = db
          .query<{ path: string }, [string]>(
            `SELECT path FROM library_songs WHERE album_id = ?
             ORDER BY COALESCE(disc, 1), COALESCE(track, 999999), path LIMIT 1`,
          )
          .get(albumId);
        if (!song) return [];
        const tags = await readTags(absoluteSongPath(musicDir, song.path));
        const artist = tags.albumArtist ?? tags.artist;
        const title = tags.album;
        if (!artist && !title) return [];
        return [
          {
            releaseGroupId: null,
            artist: artist ?? '',
            title: title ?? '',
            year: tags.year ?? null,
            releaseType: null,
            coverUrl: null,
            score: scoreCandidate(q, artist ?? '', title ?? ''),
            source: 'tags' as const,
          },
        ];
      }),
    );
  }

  const outcomes = await Promise.allSettled(jobs);
  const sources: GatherResult['sources'] = [];
  const all: MetadataCandidate[] = [];
  for (const o of outcomes) {
    // Every job's own promise chain already catches internally (runSource), so
    // this only guards against a programming error leaving a bare rejection.
    if (o.status !== 'fulfilled') continue;
    sources.push({ id: o.value.id, ok: o.value.ok });
    all.push(...o.value.candidates);
  }

  return {
    album,
    query: q,
    candidates: dedupeAndRank(all).slice(0, MAX_CANDIDATES),
    sources,
    identifyAvailable: computeIdentifyAvailable(plugins),
  };
}
