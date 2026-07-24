import { Hono } from 'hono';
import { basename, dirname, join, normalize, relative } from 'node:path';
import { unlinkSync, rmdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { createLogger } from '@nicotind/core';
import type { Song, Album, Artist } from '@nicotind/core';
import type { Lidarr } from '@nicotind/lidarr-client';
import type { AuthEnv } from '../middleware/auth.js';
import { requireAdmin, requireCurator } from '../middleware/current-user.js';
import { jobAlbumPairs } from '../services/acquisition-job-store.js';
import { errorHandler } from '../middleware/error-handler.js';
import type { Database } from 'bun:sqlite';
import { getDatabase } from '../db.js';
import type { LibraryCurator } from '../services/library-curator.js';
import { normalizeArtistForGrouping, normalizeForGrouping } from '../services/album-grouping.js';
import { transferGroupKeys } from '../services/transfer-group-keys.js';
import type { SlskdRef } from '../index.js';
import { ShareRescanScheduler } from '../services/share-rescan-scheduler.js';
import { getAcquisitionByPath } from '../services/acquisition-store.js';
import { analyzeBpm, verifyGenre } from '../services/track-analysis.js';
import type { AudioFeaturesClient } from '../services/audio-features-client.js';
import { readAudioTags, writeAudioTags } from '../services/audio-tags.js';
import { getLyrics, setLyrics, deleteLyrics } from '../services/lyrics-store.js';
import { getArtistMeta, upsertArtistMeta } from '../services/artist-meta-store.js';
import { getMbid } from '../services/mbid-store.js';
import type { PluginRegistry } from '../services/plugins/registry.js';
import { optimizeAlbum } from '../services/metadata-optimize.js';
import { rankCandidates, DEFAULT_WEIGHTS, type SongFeatures } from '../services/radio.service.js';
import { embeddingModelFor, loadEmbeddings } from '../services/embedding-store.js';
import { searchCandidates, applyMetadataFix } from '../services/metadata-fix.js';
import {
  setArtwork,
  deleteArtwork,
  purgeDiskArtCache,
  purgeCanonicalCache,
  resolveArtwork,
} from '../services/artwork-store.js';
import {
  writeArtistImageOverride,
  deleteArtistImageOverride,
  ALLOWED_OVERRIDE_TYPES,
} from '../services/artist-image-override.js';
import { clearCoverNegativeCache, extractCover, fetchRemoteCover } from './streaming.js';
import { upsertArtistIdentity, upsertArtistAlias } from '../services/artist-identity-store.js';
import { recordAudit } from '../services/audit-log.js';
import { artistIdFor } from '../services/library-scanner.js';
import { appendSongGenres, loadGenreSets, setSongGenres } from '../services/genre-split.js';
import {
  applyGenreOverride,
  backfillGenreOverrides,
  buildOverrideIndex,
  deleteGenreOverride,
  getGenreOverride,
  splitStored,
  upsertGenreOverride,
} from '../services/genre-overrides.js';
import { resizeCover } from '../services/cover-thumbnail.js';
import {
  dedupeCoverUrls,
  selectDistinctEmbeddedCovers,
  extractEmbeddedPicture,
  writeFolderCover,
} from '../services/cover-sources.js';
import { pruneOrphanArtist } from '../services/library-aggregates.js';
import { checkFragments } from '../services/library-fragments.js';
import { songOrderBy } from '../services/song-sort.js';
import { attachSongArtists, attachAlbumArtists } from '../services/artist-attach.js';
import { tokenize, matchesAllTokens, rankBy } from '../services/search-tokens.js';
import type {
  ApplyMetadataRequest,
  AlbumCoverCandidate,
  CoverCandidatesResponse,
  ApplyCoverRequest,
} from '@nicotind/core';
import { parseLibraryFilter, isLicenceCode } from '@nicotind/core';
import {
  albumFilterWheres,
  artistFilterWheres,
  songFilterWheres,
} from '../services/library-filter-sql.js';
import { MusicBrainzClient, MB_USER_AGENT } from '../services/musicbrainz-client.js';

const log = createLogger('library');

const VALID_CLASSIFICATIONS = new Set(['album', 'ep', 'single', 'compilation', 'unknown']);

// Lazily-built, per-dataDir MusicBrainz client for on-demand licence detection.
// Reuses the on-disk cache file so repeated lookups don't re-hit MB.
let mbLicenceClient: { key: string; client: MusicBrainzClient } | null = null;
function getMbLicenceClient(dataDir?: string): MusicBrainzClient | null {
  if (!dataDir) return null;
  const cacheFile = join(dataDir, 'musicbrainz-cache.json');
  if (mbLicenceClient?.key !== cacheFile) {
    mbLicenceClient = { key: cacheFile, client: new MusicBrainzClient(cacheFile, MB_USER_AGENT) };
  }
  return mbLicenceClient.client;
}

// The only release types shown in the main Albums grid. Singles & EPs are
// surfaced on the artist page and the dedicated /singles view instead, so the
// grid stays album-only. Defined once here so no album-listing endpoint can
// re-pollute the grid by forgetting the filter.
const GRID_CLASSIFICATION_SQL = `classification = 'album'`;
const SINGLE_EP_CLASSIFICATION_SQL = `classification IN ('single','ep')`;

/**
 * Returns a Set of "artist album" group keys for every album that is actively
 * downloading: active `album_jobs` rows, unioned with `extraKeys` derived from
 * in-flight slskd transfers (so raw folder-browser/per-track grabs that never
 * create a job row are suppressed too). Used to hide partially-downloaded albums
 * from library listings so the user never sees an incomplete album.
 */
function getDownloadingGroupKeys(db: Database, extraKeys?: Set<string>): Set<string> {
  const keys = new Set(extraKeys);
  // `album_jobs` UNION the unified `acquisition_jobs` (active only) via the shared
  // job-store helper — the latter also covers track-search/direct jobs.
  for (const { artistName, albumTitle } of jobAlbumPairs(db, { activeOnly: true })) {
    keys.add(`${normalizeArtistForGrouping(artistName)} ${normalizeForGrouping(albumTitle)}`);
  }
  return keys;
}

/** Cache the (potentially slow, network) slskd transfer fetch briefly so a burst
 * of listing requests doesn't hammer slskd. */
let transferKeysCache: { at: number; keys: Set<string> } | null = null;
const TRANSFER_KEYS_TTL_MS = 4000;

/** Cache the album id→group-key mapping so a burst of listing requests during an
 * active download doesn't re-scan library_albums each time. Short TTL (like the
 * transfer cache): a stale rename for a few seconds is harmless — downloading
 * albums are excluded regardless — and avoids wiring invalidation into every
 * album mutation. Only consulted when a download is actually active. Keyed by db
 * instance so it's correct in production (one db) and never leaks across the
 * many throwaway databases a test suite spins up. */
let albumKeyCache = new WeakMap<Database, { at: number; byGroupKey: Map<string, string[]> }>();
const ALBUM_KEY_TTL_MS = 4000;

/** Test hook: clear the cached transfer keys + album map so a test can change state. */
export function __resetDownloadSuppressionCache(): void {
  transferKeysCache = null;
  albumKeyCache = new WeakMap();
  quarantineCache = new WeakMap();
}

/**
 * Map every album's normalized `"artist album"` group key → its id(s), memoized
 * for {@link ALBUM_KEY_TTL_MS}. Replaces a per-request full-table scan +
 * per-row normalization with an O(active-keys) lookup during downloads.
 */
export function albumIdsByGroupKey(db: Database): Map<string, string[]> {
  const now = Date.now();
  const cached = albumKeyCache.get(db);
  if (cached && now - cached.at < ALBUM_KEY_TTL_MS) return cached.byGroupKey;
  const rows = db
    .query<{ id: string; artist: string; name: string }, []>(
      `SELECT id, artist, name FROM library_albums`,
    )
    .all();
  const byGroupKey = new Map<string, string[]>();
  for (const r of rows) {
    const key = `${normalizeArtistForGrouping(r.artist)} ${normalizeForGrouping(r.name)}`;
    const arr = byGroupKey.get(key);
    if (arr) arr.push(r.id);
    else byGroupKey.set(key, [r.id]);
  }
  albumKeyCache.set(db, { at: now, byGroupKey });
  return byGroupKey;
}

/**
 * Active-transfer group keys, fetched from slskd with a short cache. Returns an
 * empty set when slskd is absent/unreachable (fast path — suppression then keys
 * on album_jobs only). Never throws.
 */
async function activeTransferKeys(slskdRef?: SlskdRef): Promise<Set<string>> {
  if (!slskdRef?.current) return new Set();
  const now = Date.now();
  if (transferKeysCache && now - transferKeysCache.at < TRANSFER_KEYS_TTL_MS) {
    return transferKeysCache.keys;
  }
  try {
    const groups = await slskdRef.current.transfers.getDownloads();
    const keys = transferGroupKeys(groups);
    transferKeysCache = { at: now, keys };
    return keys;
  } catch {
    // slskd unreachable — degrade to album_jobs-only suppression, cache the miss
    // briefly so we don't retry on every request.
    transferKeysCache = { at: now, keys: new Set() };
    return transferKeysCache.keys;
  }
}

/**
 * Returns a SQL WHERE fragment (+ params) excluding actively-downloading albums
 * by id. This must be applied *inside* the query — pushing the exclusion down to
 * SQL keeps LIMIT/OFFSET pagination honest. Filtering post-LIMIT (the old way)
 * shrank each page below its requested size, so paginating callers re-fetched
 * already-shown rows and rendered duplicates.
 *
 * Fast path: no active downloads → empty fragment, no extra query, no change.
 */
function downloadingExclusion(
  db: Database,
  extraKeys?: Set<string>,
): { sql: string; params: string[] } {
  const keys = getDownloadingGroupKeys(db, extraKeys);
  if (keys.size === 0) return { sql: '', params: [] };
  const byGroupKey = albumIdsByGroupKey(db);
  const excluded: string[] = [];
  for (const key of keys) {
    const ids = byGroupKey.get(key);
    if (ids) excluded.push(...ids);
  }
  if (excluded.length === 0) return { sql: '', params: [] };
  return { sql: `id NOT IN (${excluded.map(() => '?').join(',')})`, params: excluded };
}

/** Cache "is any song quarantined?" briefly so a burst of listing requests during
 * a download doesn't re-run the EXISTS probe each time. Keyed by db instance (one
 * db in prod; never leaks across the throwaway DBs a test suite spins up). */
let quarantineCache = new WeakMap<Database, { at: number; any: boolean }>();
const QUARANTINE_TTL_MS = 4000;

/** True when at least one song is quarantined (landed_at IS NULL), memoized ~4s. */
function anyQuarantined(db: Database): boolean {
  const now = Date.now();
  const cached = quarantineCache.get(db);
  if (cached && now - cached.at < QUARANTINE_TTL_MS) return cached.any;
  const any =
    db
      .query<{ n: number }, []>(
        `SELECT EXISTS(SELECT 1 FROM library_songs WHERE landed_at IS NULL) AS n`,
      )
      .get()?.n === 1;
  quarantineCache.set(db, { at: now, any });
  return any;
}

/**
 * Returns a SQL WHERE fragment excluding *quarantined* albums by id — an album is
 * quarantined if ANY of its songs is still un-landed (`landed_at IS NULL`), i.e.
 * its required processing steps haven't finished, so the whole album stays hidden
 * until it's complete (matching the "never show an incomplete album" intent).
 * Applied *inside* the query (pre-LIMIT) so pagination stays honest, mirroring
 * downloadingExclusion. Fast path: no quarantined song → empty fragment, no
 * subquery. No bind params — the fragment is self-contained.
 */
function quarantineExclusion(db: Database): { sql: string; params: string[] } {
  if (!anyQuarantined(db)) return { sql: '', params: [] };
  return {
    sql: `id NOT IN (SELECT DISTINCT album_id FROM library_songs WHERE landed_at IS NULL)`,
    params: [],
  };
}

/** True when the given album has any un-landed (quarantined) song. */
function isAlbumQuarantined(db: Database, albumId: string): boolean {
  if (!anyQuarantined(db)) return false;
  return (
    db
      .query<{ n: number }, [string]>(
        `SELECT EXISTS(SELECT 1 FROM library_songs WHERE album_id = ? AND landed_at IS NULL) AS n`,
      )
      .get(albumId)?.n === 1
  );
}

const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.m4a',
  '.aac',
  '.ogg',
  '.opus',
  '.wav',
  '.wma',
  '.alac',
  '.aiff',
  '.aif',
  '.ape',
]);

interface LibraryRoutesOptions {
  curator?: LibraryCurator;
  runSync?: () => Promise<void>;
  /** Lidarr client for genre verification + metadata optimization; null when unconfigured. */
  lidarr?: Lidarr | null;
  /** Cover-cache dir, purged when an optimized album's canonical URL changes. */
  coverCacheDir?: string;
  /** Data dir root — used to persist manual artist-image overrides. */
  dataDir?: string;
  /** Plugin registry, used to resolve lyrics-capable sources on demand. */
  pluginRegistry?: PluginRegistry;
  /** slskd handle, used to suppress albums with an in-flight (non-job) transfer. */
  slskdRef?: SlskdRef;
  /** Analysis-sidecar client: preferred BPM detector for on-demand analysis
   *  (Essentia — the local music-tempo fallback makes frequent octave errors).
   *  Null when no sidecar is configured. */
  audioFeaturesClient?: AudioFeaturesClient | null;
}

interface AlbumRow {
  id: string;
  name: string;
  artist: string;
  artist_id: string;
  cover_art: string | null;
  song_count: number;
  duration: number;
  year: number | null;
  genre: string | null;
  licence: string | null;
  created: string | null;
  starred: string | null;
  classification: string;
  hidden: number;
  manual_override: number;
}

interface SongRow {
  id: string;
  album_id: string;
  album_name: string;
  album_cover_art: string | null;
  title: string;
  artist: string;
  artist_id: string;
  album_artist: string;
  album_artist_id: string;
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
  licence: string | null;
}

interface ArtistRow {
  id: string;
  name: string;
  album_count: number;
  cover_art: string | null;
  starred: string | null;
}

const ALBUM_SELECT = `
  SELECT id, name, artist, artist_id, cover_art, song_count, duration,
         year, genre, licence, created, starred, classification, hidden, manual_override
  FROM library_albums
`;

const SONG_SELECT = `
  SELECT s.id, s.album_id, a.name AS album_name, a.cover_art AS album_cover_art,
         s.title, s.artist, s.artist_id, s.album_artist, s.album_artist_id,
         s.track, s.duration, s.year, s.genre,
         s.cover_art, s.path, s.size, s.bit_rate, s.suffix, s.content_type,
         s.created, s.starred, s.bpm, s.key,
         s.energy, s.loudness, s.valence, s.danceability, s.acousticness,
         s.instrumental, s.mood, s.licence
  FROM library_songs s
  LEFT JOIN library_albums a ON a.id = s.album_id
`;

function rowToAlbum(r: AlbumRow): Album & { classification: string; hidden: boolean } {
  return {
    id: r.id,
    name: r.name,
    artist: r.artist,
    artistId: r.artist_id,
    // Cover is keyed on the album id: the cover route checks canonical artwork
    // (library_artwork) by this id, falling back to a representative song's
    // on-disk art. Using the id directly (not the stored cover_art, which is a
    // legacy song id on rows scanned before this change) makes canonical art
    // resolve without waiting for a rescan.
    coverArt: r.id,
    songCount: r.song_count,
    duration: r.duration,
    year: r.year ?? undefined,
    genre: r.genre ?? undefined,
    licence: r.licence ?? undefined,
    created: r.created ?? '',
    starred: r.starred ?? undefined,
    classification: r.classification,
    hidden: r.hidden === 1,
  };
}

function rowToSong(r: SongRow): Song {
  return {
    id: r.id,
    title: r.title,
    album: r.album_name ?? '',
    albumId: r.album_id,
    artist: r.artist,
    artistId: r.artist_id,
    albumArtist: r.album_artist || undefined,
    albumArtistId: r.album_artist_id || undefined,
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
    energy: r.energy ?? undefined,
    loudness: r.loudness ?? undefined,
    valence: r.valence ?? undefined,
    danceability: r.danceability ?? undefined,
    acousticness: r.acousticness ?? undefined,
    instrumental: r.instrumental ?? undefined,
    mood: r.mood ?? undefined,
    licence: r.licence ?? undefined,
  };
}

/** SongRow → the scorer's SongFeatures (incl. the perceptual axes). */
function songRowFeatures(r: SongRow): SongFeatures {
  return {
    bpm: r.bpm ?? undefined,
    key: r.key ?? undefined,
    genre: r.genre ?? undefined,
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

function rowToArtist(r: ArtistRow): Artist {
  return {
    id: r.id,
    name: r.name,
    albumCount: r.album_count,
    // Keyed on the artist id so the cover route serves the canonical Lidarr
    // poster (audio files carry none); disk fallback finds a representative song.
    coverArt: r.id,
    starred: r.starred ?? undefined,
  };
}

function albumOrderBy(type: string): string {
  switch (type) {
    case 'newest':
      return 'created DESC, name COLLATE NOCASE ASC';
    case 'random':
      return 'RANDOM()';
    case 'recent':
      return 'created DESC';
    case 'frequent':
      // Navidrome's "frequent" requires play-count data we don't sync yet.
      return 'created DESC';
    case 'starred':
      return 'starred DESC, name COLLATE NOCASE ASC';
    case 'alphabeticalByName':
    default:
      return 'name COLLATE NOCASE ASC';
  }
}

export function libraryRoutes(musicDir?: string, options: LibraryRoutesOptions = {}) {
  const app = new Hono<AuthEnv>();
  // Self-contained error mapping so typed throws (e.g. requireAdmin's
  // ForbiddenError) become the standard { error, code } + status even when this
  // router is mounted on a bare app (as the route tests do) without the global
  // onError. Mirrors the app-level handler.
  app.onError(errorHandler);
  const {
    curator,
    runSync,
    lidarr,
    coverCacheDir,
    dataDir,
    pluginRegistry,
    audioFeaturesClient,
    slskdRef,
  } = options;
  // A deleted file's slskd share entry doesn't go away on its own — see
  // ShareRescanScheduler. Debounced so an album/bulk delete triggers one
  // rescan, not one per file; a no-op (never scheduled) when slskd isn't
  // configured.
  const shareRescan = new ShareRescanScheduler(async () => {
    const slskd = slskdRef?.current;
    if (slskd) await slskd.shares.rescan();
  });

  app.get('/artists', (c) => {
    const db = getDatabase();
    // Metadata filters use any-track semantics: an artist matches when at
    // least one of their songs does (see library-filter-sql.ts). With no
    // filter params this stays byte-identical to the historical query.
    const filter = parseLibraryFilter(c.req.queries());
    const frag = artistFilterWheres(filter);
    const filterClause = frag.wheres.length ? ` AND ${frag.wheres.join(' AND ')}` : '';
    // Hide an artist whose only tracks are still quarantined — until at least one
    // of their songs has landed they aren't "in the library" yet. Fast path: only
    // when something is actually quarantined (steady state adds no clause).
    const quarantineClause = anyQuarantined(db)
      ? ` AND EXISTS (SELECT 1 FROM library_songs s WHERE (s.artist_id = library_artists.id` +
        ` OR s.id IN (SELECT song_id FROM library_song_artists WHERE artist_id = library_artists.id))` +
        ` AND s.landed_at IS NOT NULL)`
      : '';
    const rows = db
      .query<ArtistRow, (string | number)[]>(
        // split_compound = 0: a compound that split ("Charly García y Luis
        // Alberto Spinetta") is represented by its member tiles, not its own —
        // the row stays reachable via direct links/search.
        `SELECT id, name, album_count, cover_art, starred
         FROM library_artists
         WHERE hidden = 0 AND split_compound = 0 AND name != 'Various Artists' COLLATE NOCASE${filterClause}${quarantineClause}
         ORDER BY name COLLATE NOCASE ASC`,
      )
      .all(...frag.params);
    return c.json(rows.map(rowToArtist));
  });

  // Resolve an artist *name* to its canonical id so the player/search can link a
  // track with no known `artistId` (e.g. a Soulseek network hit) to the real
  // artist page when that artist exists locally. Diacritic-insensitive; 404 when
  // the artist isn't in the library (caller falls back to /library).
  app.get('/artists/by-name', (c) => {
    const name = (c.req.query('name') ?? '').trim();
    if (!name) return c.json({ error: 'Missing name' }, 400);
    const db = getDatabase();
    // Fast path: exact case-insensitive match.
    const exact = db
      .query<{ id: string }, [string]>(
        `SELECT id FROM library_artists WHERE name = ? COLLATE NOCASE AND hidden = 0 LIMIT 1`,
      )
      .get(name);
    if (exact) return c.json({ id: exact.id });
    // Fallback: diacritic-folded scan ("La Portuária" ↔ "La Portuaria").
    const target = normalizeArtistForGrouping(name);
    const rows = db
      .query<{ id: string; name: string }, []>(
        `SELECT id, name FROM library_artists WHERE hidden = 0`,
      )
      .all();
    const match = rows.find((r) => normalizeArtistForGrouping(r.name) === target);
    if (!match) return c.json({ error: 'Artist not found' }, 404);
    return c.json({ id: match.id });
  });

  app.get('/artists/:id', async (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const artistRow = db
      .query<ArtistRow, [string]>(
        `SELECT id, name, album_count, cover_art, starred
         FROM library_artists WHERE id = ?`,
      )
      .get(id);
    if (!artistRow) {
      return c.json({ error: 'Artist not found' }, 404);
    }
    // Quarantined albums (a required processing step unfinished) are hidden here
    // too — same treatment as the main grid. Self-contained subquery, fast-pathed.
    const artistQ = quarantineExclusion(db);
    const artistQClause = artistQ.sql ? ` AND ${artistQ.sql}` : '';
    const allRows = db
      .query<AlbumRow, [string, string]>(
        `${ALBUM_SELECT} WHERE (artist_id = ? OR id IN (SELECT album_id FROM library_album_artists WHERE artist_id = ?)) AND hidden = 0${artistQClause}
         ORDER BY year DESC NULLS LAST, name COLLATE NOCASE ASC`,
      )
      .all(id, id);
    const downloadingKeys = getDownloadingGroupKeys(db, await activeTransferKeys(options.slskdRef));
    const visible = allRows.filter(
      (r) =>
        !downloadingKeys.has(
          `${normalizeArtistForGrouping(r.artist)} ${normalizeForGrouping(r.name)}`,
        ),
    );
    // Split full-lengths (the grid) from singles & EPs (their own section).
    const albums = visible
      .filter((r) => r.classification !== 'single' && r.classification !== 'ep')
      .map(rowToAlbum);
    const singlesAndEps = visible
      .filter((r) => r.classification === 'single' || r.classification === 'ep')
      .map(rowToAlbum);
    attachAlbumArtists(db, albums);
    attachAlbumArtists(db, singlesAndEps);
    const meta = getArtistMeta(db, id);
    return c.json({
      artist: { ...rowToArtist(artistRow), bio: meta?.bio ?? null, urls: meta?.urls ?? [] },
      albums,
      singlesAndEps,
    });
  });

  /**
   * Force a re-fetch of this artist's bio/links from an artist-info-capable
   * source (Discogs), even if a row already exists — unless it's a curator's
   * manual override, which this never touches (issue #195).
   */
  app.post('/artists/:id/refresh-info', async (c) => {
    requireCurator(c);
    const id = c.req.param('id');
    const db = getDatabase();
    const artist = db
      .query<{ id: string; name: string }, [string]>(
        `SELECT id, name FROM library_artists WHERE id = ?`,
      )
      .get(id);
    if (!artist) return c.json({ error: 'Artist not found' }, 404);

    const existing = getArtistMeta(db, id);
    if (existing?.manualOverride) {
      return c.json(
        { error: 'This artist has a manual bio/links override — clear it before refreshing.' },
        409,
      );
    }

    const mbidRow = getMbid(db, 'artist', normalizeArtistForGrouping(artist.name));
    if (!mbidRow) {
      upsertArtistMeta(db, { artistId: id, bio: null, urls: [], source: 'discogs' });
      return c.json({ bio: null, urls: [] });
    }

    const [provider] = pluginRegistry?.getEnabledWithCapability('artist-info') ?? [];
    const info = provider?.artistInfo
      ? await provider.artistInfo.fetchArtistInfo({ mbid: mbidRow.mbid })
      : null;
    if (!info) {
      upsertArtistMeta(db, { artistId: id, bio: null, urls: [], source: 'discogs' });
      return c.json({ bio: null, urls: [] });
    }
    upsertArtistMeta(db, { artistId: id, bio: info.bio, urls: info.urls, source: info.source });
    return c.json({ bio: info.bio, urls: info.urls });
  });

  /** Curator hand-edit of an artist's bio/links — locks out the background task. */
  app.put('/artists/:id/info', async (c) => {
    requireCurator(c);
    const id = c.req.param('id');
    const db = getDatabase();
    const artist = db
      .query<{ id: string }, [string]>(`SELECT id FROM library_artists WHERE id = ?`)
      .get(id);
    if (!artist) return c.json({ error: 'Artist not found' }, 404);

    const body = await c.req.json<{ bio?: string | null; urls?: string[] }>().catch(() => null);
    if (!body) return c.json({ error: 'Invalid body' }, 400);
    const bio = body.bio?.trim() || null;
    const urls = (body.urls ?? []).map((u) => u.trim()).filter(Boolean);

    upsertArtistMeta(db, { artistId: id, bio, urls, source: 'user', manualOverride: true });
    return c.json({ bio, urls });
  });

  // Paginated individual songs for one artist (the artist page's "Songs" tab —
  // lazy-loaded, sortable, starred-filterable). Separate from /artists/:id so the
  // potentially-large track list loads on demand, not with the album shell.
  app.get('/artists/:id/songs', (c) => {
    const id = c.req.param('id');
    const size = Math.min(Number(c.req.query('size') ?? 60), 200);
    const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);
    const sort = c.req.query('sort') ?? 'newest';
    const db = getDatabase();
    const wheres = [
      '(s.artist_id = ? OR s.id IN (SELECT song_id FROM library_song_artists WHERE artist_id = ?))',
      's.hidden = 0',
      // Quarantined songs aren't in the library yet — exclude from the Songs tab.
      's.landed_at IS NOT NULL',
    ];
    const params: Array<string | number> = [id, id];
    // Standardized metadata filters (bpm/key/mood/…); `starred=true` is part of
    // the same grammar and keeps its historical meaning here (song-level).
    const frag = songFilterWheres(parseLibraryFilter(c.req.queries()), 's');
    wheres.push(...frag.wheres);
    params.push(...frag.params);
    const rows = db
      .query<SongRow, (string | number)[]>(
        `${SONG_SELECT} WHERE ${wheres.join(' AND ')}
         ORDER BY ${songOrderBy(sort)} LIMIT ? OFFSET ?`,
      )
      .all(...params, size, offset);
    const songs = rows.map(rowToSong);
    attachSongArtists(db, songs);
    return c.json(songs);
  });

  app.get('/artists/:id/appears-on', (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const q = quarantineExclusion(db);
    const rows = db
      .query<AlbumRow, [string, string]>(
        `${ALBUM_SELECT} WHERE id IN (
           SELECT DISTINCT ls.album_id FROM library_songs ls
           JOIN library_albums la ON la.id = ls.album_id
           WHERE (ls.artist_id = ? OR ls.id IN (SELECT song_id FROM library_song_artists WHERE artist_id = ?))
             AND la.classification = 'compilation' AND la.hidden = 0
         )${q.sql ? ` AND ${q.sql}` : ''}
         ORDER BY year DESC NULLS LAST, name COLLATE NOCASE ASC`,
      )
      .all(id, id);
    const albums = rows.map(rowToAlbum);
    attachAlbumArtists(db, albums);
    return c.json(albums);
  });

  // Dedicated singles & EPs listing (the /library/singles view). Mirrors /albums
  // but inverts the grid filter: only single + ep releases.
  app.get('/singles', async (c) => {
    const type = c.req.query('type') ?? 'newest';
    const size = Math.min(Number(c.req.query('size') ?? 60), 500);
    const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);
    const order = albumOrderBy(type);
    const db = getDatabase();
    // Exclude actively-downloading albums in SQL (pre-LIMIT) to keep pagination
    // correct — see downloadingExclusion(). Also keys on in-flight slskd transfers.
    const excl = downloadingExclusion(db, await activeTransferKeys(options.slskdRef));
    const wheres = ['hidden = 0', SINGLE_EP_CLASSIFICATION_SQL];
    const params: Array<string | number> = [];
    if (excl.sql) {
      wheres.push(excl.sql);
      params.push(...excl.params);
    }
    // Hide albums still in quarantine (a required processing step hasn't finished).
    const q = quarantineExclusion(db);
    if (q.sql) wheres.push(q.sql);
    const frag = albumFilterWheres(parseLibraryFilter(c.req.queries()));
    wheres.push(...frag.wheres);
    params.push(...frag.params);
    const rows = db
      .query<AlbumRow, (string | number)[]>(
        `${ALBUM_SELECT} WHERE ${wheres.join(' AND ')}
         ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...params, size, offset);
    const singles = rows.map(rowToAlbum);
    attachAlbumArtists(db, singles);
    return c.json(singles);
  });

  app.get('/albums', async (c) => {
    const type = c.req.query('type') ?? 'newest';
    const size = Math.min(Number(c.req.query('size') ?? 20), 500);
    const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);
    const includeHidden = c.req.query('includeHidden') === 'true';
    const classification = c.req.query('classification');

    const db = getDatabase();
    const wheres: string[] = [];
    const params: Array<string | number> = [];
    if (!includeHidden) wheres.push('hidden = 0');
    if (classification && VALID_CLASSIFICATIONS.has(classification)) {
      // Explicit classification filter (power users / internal callers).
      wheres.push('classification = ?');
      params.push(classification);
    } else {
      // Default grid: album-only (singles & EPs live on the artist page / the
      // /singles view).
      wheres.push(GRID_CLASSIFICATION_SQL);
    }
    // Exclude actively-downloading albums in SQL (not post-LIMIT) so pagination
    // stays correct — see downloadingExclusion(). Also keys on in-flight transfers.
    const excl = downloadingExclusion(db, await activeTransferKeys(options.slskdRef));
    if (excl.sql) {
      wheres.push(excl.sql);
      params.push(...excl.params);
    }
    // Hide albums still in quarantine (a required processing step hasn't finished).
    const q = quarantineExclusion(db);
    if (q.sql) wheres.push(q.sql);
    // Standardized metadata filters: song-level properties match any-track via
    // EXISTS, starred filters the album row itself (library-filter-sql.ts).
    const filterFrag = albumFilterWheres(parseLibraryFilter(c.req.queries()));
    wheres.push(...filterFrag.wheres);
    params.push(...filterFrag.params);

    const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
    const order = albumOrderBy(type);

    const rows = db
      .query<AlbumRow, (string | number)[]>(
        `${ALBUM_SELECT} ${whereClause} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...params, size, offset);
    const albums = rows.map(rowToAlbum);
    attachAlbumArtists(db, albums);
    return c.json(albums);
  });

  app.get('/compilations', async (c) => {
    const type = c.req.query('type') ?? 'newest';
    const size = Math.min(Number(c.req.query('size') ?? 20), 500);
    const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);
    const db = getDatabase();
    const order = albumOrderBy(type);
    const wheres = ['hidden = 0', `classification = 'compilation'`];
    const params: Array<string | number> = [];
    // Hide albums still in quarantine (a required processing step hasn't finished).
    const q = quarantineExclusion(db);
    if (q.sql) wheres.push(q.sql);
    const frag = albumFilterWheres(parseLibraryFilter(c.req.queries()));
    wheres.push(...frag.wheres);
    params.push(...frag.params);
    const rows = db
      .query<AlbumRow, (string | number)[]>(
        `${ALBUM_SELECT} WHERE ${wheres.join(' AND ')}
         ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...params, size, offset);
    const compilations = rows.map(rowToAlbum);
    attachAlbumArtists(db, compilations);
    return c.json(compilations);
  });

  app.get('/albums/:id', (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const albumRow = db.query<AlbumRow, [string]>(`${ALBUM_SELECT} WHERE id = ?`).get(id);
    if (!albumRow) {
      return c.json({ error: 'Album not found' }, 404);
    }
    // Hide the album while it's still in quarantine (a required processing step
    // hasn't finished for one of its tracks) — same "not in the library yet"
    // treatment the grid gives it, so a deep link can't reach a half-processed album.
    if (isAlbumQuarantined(db, id)) {
      return c.json({ error: 'Album not found' }, 404);
    }
    const songRows = db
      .query<SongRow, [string]>(
        `${SONG_SELECT} WHERE s.album_id = ? AND s.hidden = 0 AND s.landed_at IS NOT NULL
         ORDER BY s.track ASC NULLS LAST, s.title COLLATE NOCASE ASC`,
      )
      .all(id);
    const album = rowToAlbum(albumRow);
    const songs = songRows.map(rowToSong);
    attachAlbumArtists(db, [album]);
    attachSongArtists(db, songs);
    return c.json({ ...album, song: songs });
  });

  app.delete('/albums/:id', async (c) => {
    requireCurator(c);

    const albumId = c.req.param('id');
    const db = getDatabase();

    // The canonical DB is the single source of truth for the tracklist.
    const albumRow = db
      .query<
        { name: string; artist: string; artist_id: string | null; genre: string | null },
        [string]
      >('SELECT name, artist, artist_id, genre FROM library_albums WHERE id = ?')
      .get(albumId);
    const canonicalSongs = db
      .query<{ id: string; path: string; artist_id: string | null }, [string]>(
        'SELECT id, path, artist_id FROM library_songs WHERE album_id = ?',
      )
      .all(albumId);
    const songIds: string[] = canonicalSongs.map((s) => s.id);
    const songPaths: string[] = canonicalSongs.map((s) => s.path);

    if (songIds.length === 0 && !albumRow) {
      return c.json({ error: 'Album not found' }, 404);
    }

    const failed: Array<{ id: string; error: string }> = [];
    let deletedCount = 0;

    // Reliable path: drop the whole album folder in one shot. Falls back to
    // per-file deletion for scattered/multi-disc tracks and shared "Singles".
    let folderDeleted = false;
    if (musicDir && songPaths.length > 0 && songPaths.length === songIds.length) {
      const expandedMusicDir = expandDir(musicDir);
      const fullPaths = songPaths
        .map((p) => resolveSongPath(expandedMusicDir, p))
        .filter((p) => isUnderMusicDir(expandedMusicDir, p));
      if (fullPaths.length === songPaths.length) {
        folderDeleted = tryDeleteAlbumFolder(fullPaths, expandedMusicDir);
      }
    }

    if (folderDeleted) {
      deletedCount = songIds.length;
      shareRescan.schedule();
    } else {
      const results = await Promise.allSettled(songIds.map((id) => deleteOne(id)));
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === 'fulfilled' && r.value.ok) {
          deletedCount++;
        } else {
          const err = r.status === 'fulfilled' ? r.value.error : 'Unexpected error';
          failed.push({ id: songIds[i]!, error: err ?? 'Unknown error' });
        }
      }
    }

    // Remove the album from the canonical tables synchronously. The scanner reads
    // straight from disk (and the files are now gone), so a later rescan won't
    // resurrect it — no tombstone/async-scan reconciliation needed.
    db.transaction(() => {
      if (songIds.length > 0) {
        const placeholders = songIds.map(() => '?').join(',');
        db.run(`DELETE FROM completed_downloads WHERE navidrome_id IN (${placeholders})`, songIds);
      }
      db.run('DELETE FROM library_songs WHERE album_id = ?', [albumId]);
      db.run('DELETE FROM library_albums WHERE id = ?', [albumId]);

      // Clean up the aggregate rows the canonical-row delete would otherwise
      // leave stale until the next *full* scan. Without this, deleting an
      // artist's only release orphans its `library_artists` row: the artist
      // keeps showing in search (the local provider reads `library_artists`)
      // and its page renders empty (`/artists/:id` returns the shell from
      // `library_artists` with no albums). See
      // docs/e2e-playground-findings-2026-06.md §D.
      const artistId = albumRow?.artist_id ?? canonicalSongs.find((s) => s.artist_id)?.artist_id;
      if (artistId) pruneOrphanArtist(db, artistId);

      // Drop a genre row only once nothing references it — recomputing exact
      // counts for a large shared genre on every delete isn't worth it (a full
      // scan refreshes them), but a genre that's now empty should disappear.
      const genre = albumRow?.genre;
      if (genre) {
        const stillUsed =
          db.query('SELECT 1 FROM library_albums WHERE genre = ? LIMIT 1').get(genre) !== null ||
          db.query('SELECT 1 FROM library_songs WHERE genre = ? LIMIT 1').get(genre) !== null;
        if (!stillUsed) db.run('DELETE FROM library_genres WHERE name = ?', [genre]);
      }

      // The album's own canonical artwork row survives rescans by design, but a
      // deleted album should not keep one.
      db.run('DELETE FROM library_artwork WHERE id = ?', [albumId]);
    })();

    log.info(
      { albumId, deletedCount, failedCount: failed.length, folderDeleted },
      'Album deletion complete',
    );
    recordAudit(db, c.get('user'), 'album.delete', {
      targetKind: 'album',
      targetId: albumId,
      detail: `${albumRow ? `${albumRow.artist} — ${albumRow.name}, ` : ''}${deletedCount} song(s) deleted`,
    });
    return c.json({ ok: failed.length === 0, deletedCount, failedCount: failed.length, failed });
  });

  // GET /api/library/untracked  (admin)
  // Completed downloads with no relative_path — files that predate the library
  // organizer and are otherwise invisible to playlist/deletion logic. Run the
  // backfill-untracked script to resolve the ones still on disk.
  app.get('/untracked', (c) => {
    requireAdmin(c);
    const db = getDatabase();
    const limit = Math.min(Number(c.req.query('limit') ?? 200) || 200, 1000);
    const total = (
      db
        .query('SELECT COUNT(*) AS c FROM completed_downloads WHERE relative_path IS NULL')
        .get() as {
        c: number;
      }
    ).c;
    const rows = db
      .query(
        `SELECT transfer_key AS transferKey, username, directory, filename, basename,
                completed_at AS completedAt
         FROM completed_downloads
         WHERE relative_path IS NULL
         ORDER BY completed_at DESC
         LIMIT ?`,
      )
      .all(limit);
    return c.json({ total, rows });
  });

  // --- Curation admin endpoints -------------------------------------------------
  app.post('/albums/:id/hide', (c) => {
    requireCurator(c);
    if (!curator) return c.json({ error: 'Curator not available' }, 503);
    const ok = curator.setManualOverride(c.req.param('id'), { hidden: true });
    return c.json({ ok });
  });

  app.post('/albums/:id/unhide', (c) => {
    requireCurator(c);
    if (!curator) return c.json({ error: 'Curator not available' }, 503);
    const ok = curator.setManualOverride(c.req.param('id'), { hidden: false });
    return c.json({ ok });
  });

  app.post('/albums/:id/reclassify', async (c) => {
    requireCurator(c);
    if (!curator) return c.json({ error: 'Curator not available' }, 503);
    const body = await c.req.json<{ classification?: string }>();
    const cls = body.classification;
    if (!cls || !VALID_CLASSIFICATIONS.has(cls)) {
      return c.json({ error: 'Invalid classification' }, 400);
    }
    const ok = curator.setManualOverride(c.req.param('id'), {
      classification: cls as 'album' | 'single' | 'compilation' | 'unknown',
    });
    return c.json({ ok });
  });

  app.post('/albums/:id/clear-override', (c) => {
    requireCurator(c);
    if (!curator) return c.json({ error: 'Curator not available' }, 503);
    const ok = curator.clearManualOverride(c.req.param('id'));
    return c.json({ ok });
  });

  // Re-fetch better cover/year/release-type for one album from Lidarr and
  // overwrite what's stored (the "fix a wrong/poor thumbnail" action). Admin
  // only; 503 when Lidarr is unconfigured, 404 when the album/match is absent.
  app.post('/albums/:id/optimize-metadata', async (c) => {
    requireCurator(c);
    if (!lidarr) return c.json({ error: 'Lidarr not configured' }, 503);
    const result = await optimizeAlbum(getDatabase(), lidarr, c.req.param('id'), {
      apply: true,
      coverCacheDir,
    });
    if (!result.matched) {
      return c.json({ ...result, error: 'No confident Lidarr match for this album' }, 404);
    }
    return c.json(result);
  });

  // User-driven metadata fix: search Lidarr/MusicBrainz with an *editable* query
  // (defaults to the album's current "<artist> <album>", which the user can
  // override when the stored artist is wrong — e.g. "<Desconocido>") and return
  // ranked candidates to confirm. Admin only; 503 without Lidarr.
  app.get('/albums/:id/metadata-candidates', async (c) => {
    requireCurator(c);
    if (!lidarr) return c.json({ error: 'Lidarr not configured' }, 503);
    const res = await searchCandidates(getDatabase(), lidarr, c.req.param('id'), c.req.query('q'));
    if (!res) return c.json({ error: 'Album not found' }, 404);
    return c.json(res);
  });

  // Apply a confirmed correction (from a candidate or free-text). Persists an
  // override the scanner honors and re-buckets the canonical rows immediately.
  // Admin only. Does NOT require Lidarr (free-text fallback works offline).
  app.post('/albums/:id/metadata', async (c) => {
    requireCurator(c);
    const body = await c.req.json<ApplyMetadataRequest>().catch(() => ({}) as ApplyMetadataRequest);
    if (
      !body.artist?.trim() &&
      !body.album?.trim() &&
      body.year == null &&
      !body.coverUrl &&
      !body.releaseType
    ) {
      return c.json({ error: 'Nothing to apply' }, 400);
    }
    const result = applyMetadataFix(getDatabase(), c.req.param('id'), body, { coverCacheDir });
    if (!result) return c.json({ error: 'Album not found' }, 404);
    return c.json(result);
  });

  // Cover picker: aggregate the covers a user can choose from to fix an album's
  // artwork — the current cover, deduped Lidarr alternatives (omitted when Lidarr
  // is unconfigured, not a 503), and one entry per *distinct* image embedded in
  // the album's own tracks. Admin only.
  app.get('/albums/:id/cover-candidates', async (c) => {
    requireCurator(c);
    const id = c.req.param('id');
    const db = getDatabase();
    const album = db
      .query<{ id: string }, [string]>('SELECT id FROM library_albums WHERE id = ?')
      .get(id);
    if (!album) return c.json({ error: 'Album not found' }, 404);

    const current: AlbumCoverCandidate = {
      source: 'current',
      url: `/api/cover/${id}`,
      label: 'Current',
    };

    let lidarr_: AlbumCoverCandidate[] = [];
    if (lidarr) {
      const res = await searchCandidates(db, lidarr, id, c.req.query('q'));
      const cands = res?.candidates ?? [];
      const labelByUrl = new Map<string, string>();
      for (const cand of cands) {
        if (cand.coverUrl && !labelByUrl.has(cand.coverUrl)) {
          labelByUrl.set(cand.coverUrl, `${cand.title}${cand.year ? ` (${cand.year})` : ''}`);
        }
      }
      lidarr_ = dedupeCoverUrls(cands.map((x) => x.coverUrl)).map((url) => ({
        source: 'lidarr' as const,
        url,
        label: labelByUrl.get(url) ?? 'Lidarr cover',
      }));
    }

    let files: AlbumCoverCandidate[] = [];
    if (musicDir) {
      const md = expandDir(musicDir);
      const songs = db
        .query<{ id: string; path: string }, [string]>(
          `SELECT id, path FROM library_songs WHERE album_id = ?
           ORDER BY COALESCE(disc, 1), COALESCE(track, 999999), path`,
        )
        .all(id);
      const sources = songs
        .map((s) => ({ id: s.id, absPath: resolveSongPath(md, s.path) }))
        .filter((s) => isUnderMusicDir(md, s.absPath) && existsSync(s.absPath));
      const distinct = await selectDistinctEmbeddedCovers(sources, (p) =>
        extractEmbeddedPicture(p),
      );
      files = distinct.map((d) => ({
        source: 'file' as const,
        songId: d.songId,
        url: `/api/cover/${d.songId}?embedded=1`,
        label: "From this album's files",
      }));
    }

    const payload: CoverCandidatesResponse = { current, lidarr: lidarr_, files };
    return c.json(payload);
  });

  // Cover-only apply (admin): set just the album cover, leaving artist/album/year
  // untouched. A `coverUrl` (Lidarr alt / custom URL) becomes the canonical
  // artwork; a `songId` materializes that track's embedded image as the album's
  // folder cover and clears the canonical override so the file art is served.
  app.post('/albums/:id/cover', async (c) => {
    requireCurator(c);
    const id = c.req.param('id');
    const db = getDatabase();
    const album = db
      .query<{ id: string }, [string]>('SELECT id FROM library_albums WHERE id = ?')
      .get(id);
    if (!album) return c.json({ error: 'Album not found' }, 404);

    const body = await c.req.json<ApplyCoverRequest>().catch(() => ({}) as ApplyCoverRequest);

    const coverUrl = body.coverUrl?.trim();
    if (coverUrl) {
      setArtwork(db, id, 'album', coverUrl, coverCacheDir);
      clearCoverNegativeCache(id); // in case this id was 404-cached as artless
      return c.json({ ok: true });
    }

    const songId = body.songId?.trim();
    if (songId) {
      if (!musicDir) return c.json({ error: 'Music directory not configured' }, 503);
      const song = db
        .query<{ path: string }, [string, string]>(
          'SELECT path FROM library_songs WHERE id = ? AND album_id = ?',
        )
        .get(songId, id);
      if (!song) return c.json({ error: 'Song not in this album' }, 404);
      const md = expandDir(musicDir);
      const abs = resolveSongPath(md, song.path);
      if (!isUnderMusicDir(md, abs) || !existsSync(abs)) {
        return c.json({ error: 'Song file not found' }, 404);
      }
      const pic = await extractEmbeddedPicture(abs);
      if (!pic) return c.json({ error: 'That track has no embedded artwork' }, 400);
      writeFolderCover(dirname(abs), pic);
      deleteArtwork(db, id, coverCacheDir); // clear canonical → folder art wins
      if (coverCacheDir) purgeDiskArtCache(coverCacheDir, id);
      clearCoverNegativeCache(id); // in case this id was 404-cached as artless
      return c.json({ ok: true });
    }

    return c.json({ error: 'Provide coverUrl or songId' }, 400);
  });

  // Upload a custom cover image (multipart form-data, field "image"). Converted to
  // a standardized square WebP (resizeCover, same treatment thumbnails get) before
  // being written as the album's folder cover, so an arbitrary upload ends up
  // looking/behaving like every other cover this route serves. Admin only.
  app.put('/albums/:id/cover', async (c) => {
    requireCurator(c);
    const id = c.req.param('id');
    if (!musicDir) return c.json({ error: 'Music directory not configured' }, 503);
    const db = getDatabase();
    const album = db
      .query<{ id: string }, [string]>('SELECT id FROM library_albums WHERE id = ?')
      .get(id);
    if (!album) return c.json({ error: 'Album not found' }, 404);

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: 'Expected multipart form-data' }, 400);
    }
    const file = form.get('image');
    if (!(file instanceof File)) return c.json({ error: 'Missing "image" file' }, 400);
    const contentType = file.type || '';
    if (!(ALLOWED_OVERRIDE_TYPES as readonly string[]).includes(contentType)) {
      return c.json({ error: 'Unsupported image type (use JPEG, PNG or WebP)' }, 415);
    }
    if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
      return c.json({ error: 'Image too large (max 8 MB)' }, 413);
    }
    const data = new Uint8Array(await file.arrayBuffer());
    if (data.length === 0) return c.json({ error: 'Empty image' }, 400);

    const md = expandDir(musicDir);
    const song = db
      .query<{ path: string }, [string]>(
        `SELECT path FROM library_songs WHERE album_id = ?
         ORDER BY COALESCE(disc, 1), COALESCE(track, 999999), path LIMIT 1`,
      )
      .get(id);
    const abs = song ? resolveSongPath(md, song.path) : null;
    if (!abs || !isUnderMusicDir(md, abs) || !existsSync(abs)) {
      return c.json({ error: 'Album has no track files to store a cover next to' }, 404);
    }

    let resized: { data: Uint8Array; contentType: string };
    try {
      resized = await resizeCover(data, 1200);
    } catch {
      return c.json({ error: 'Could not read that image' }, 400);
    }

    writeFolderCover(dirname(abs), resized);
    deleteArtwork(db, id, coverCacheDir); // clear canonical → folder art wins
    if (coverCacheDir) purgeDiskArtCache(coverCacheDir, id);
    clearCoverNegativeCache(id); // in case this id was 404-cached as artless
    return c.json({ ok: true });
  });

  // ── Artist image override (admin) ──────────────────────────────────────────
  // Give an artist a proper portrait — uploaded, or copied from one of the
  // artist's album covers — overriding the auto (Lidarr/Spotify) artwork and the
  // neutral placeholder. Stored as bytes keyed on the artist id and flagged
  // manual_override=1 so the enrichment task leaves the choice alone.
  // Shared by the artist-image and album-cover upload routes.
  const MAX_IMAGE_UPLOAD_BYTES = 8 * 1024 * 1024;

  /** Persist override bytes for an artist + flip the manual flag + bust caches. */
  function commitArtistImage(
    db: Database,
    artistId: string,
    data: Uint8Array,
    contentType: string,
  ): void {
    writeArtistImageOverride(dataDir!, artistId, data, contentType);
    db.run('UPDATE library_artists SET manual_override = 1 WHERE id = ?', [artistId]);
    // The override occupies the un-prefixed cache namespace for this id; drop any
    // sized variants and the negative 404 so the new portrait shows immediately.
    if (coverCacheDir) purgeDiskArtCache(coverCacheDir, artistId);
    clearCoverNegativeCache(artistId);
  }

  function findArtist(db: Database, id: string): boolean {
    return !!db
      .query<{ id: string }, [string]>('SELECT id FROM library_artists WHERE id = ?')
      .get(id);
  }

  // Upload a custom portrait (multipart form-data, field "image"). Admin only.
  app.put('/artists/:id/image', async (c) => {
    requireCurator(c);
    if (!dataDir) return c.json({ error: 'Data directory not configured' }, 503);
    const id = c.req.param('id');
    const db = getDatabase();
    if (!findArtist(db, id)) return c.json({ error: 'Artist not found' }, 404);

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: 'Expected multipart form-data' }, 400);
    }
    const file = form.get('image');
    if (!(file instanceof File)) return c.json({ error: 'Missing "image" file' }, 400);
    const contentType = file.type || '';
    if (!(ALLOWED_OVERRIDE_TYPES as readonly string[]).includes(contentType)) {
      return c.json({ error: 'Unsupported image type (use JPEG, PNG or WebP)' }, 415);
    }
    if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
      return c.json({ error: 'Image too large (max 8 MB)' }, 413);
    }
    const data = new Uint8Array(await file.arrayBuffer());
    if (data.length === 0) return c.json({ error: 'Empty image' }, 400);

    commitArtistImage(db, id, data, contentType);
    return c.json({ ok: true });
  });

  // Copy one of the artist's album covers into the portrait slot. Admin only.
  app.post('/artists/:id/image/from-album', async (c) => {
    requireCurator(c);
    if (!dataDir) return c.json({ error: 'Data directory not configured' }, 503);
    const id = c.req.param('id');
    const db = getDatabase();
    if (!findArtist(db, id)) return c.json({ error: 'Artist not found' }, 404);

    const body = await c.req.json<{ albumId?: string }>().catch(() => ({}) as { albumId?: string });
    const albumId = body.albumId?.trim();
    if (!albumId) return c.json({ error: 'Provide albumId' }, 400);
    const album = db
      .query<{ id: string }, [string, string]>(
        'SELECT id FROM library_albums WHERE id = ? AND artist_id = ?',
      )
      .get(albumId, id);
    if (!album) return c.json({ error: 'Album not found for this artist' }, 404);

    // Resolve the album's cover bytes exactly as the cover route does: canonical
    // URL first, then on-disk folder/embedded art.
    let bytes = null;
    const canonical = resolveArtwork(db, albumId);
    if (canonical) bytes = await fetchRemoteCover(canonical.url);
    if (!bytes && musicDir) {
      const md = expandDir(musicDir);
      const song = db
        .query<{ path: string }, [string]>(
          `SELECT path FROM library_songs WHERE album_id = ?
           ORDER BY COALESCE(disc, 1), COALESCE(track, 999999), path LIMIT 1`,
        )
        .get(albumId);
      if (song) {
        const abs = resolveSongPath(md, song.path);
        if (isUnderMusicDir(md, abs) && existsSync(abs)) bytes = await extractCover(abs);
      }
    }
    if (!bytes) return c.json({ error: 'That album has no cover to copy' }, 400);

    commitArtistImage(db, id, bytes.data, bytes.contentType);
    return c.json({ ok: true });
  });

  // Remove the manual override → revert to auto (canonical) artwork or placeholder.
  app.delete('/artists/:id/image', async (c) => {
    requireCurator(c);
    if (!dataDir) return c.json({ error: 'Data directory not configured' }, 503);
    const id = c.req.param('id');
    const db = getDatabase();
    if (!findArtist(db, id)) return c.json({ error: 'Artist not found' }, 404);

    deleteArtistImageOverride(dataDir, id);
    db.run('UPDATE library_artists SET manual_override = 0 WHERE id = ?', [id]);
    if (coverCacheDir) {
      purgeDiskArtCache(coverCacheDir, id);
      purgeCanonicalCache(coverCacheDir, id); // also drop any stale auto-artwork cache
    }
    clearCoverNegativeCache(id);
    return c.json({ ok: true });
  });

  // User-corrected artist identity (admin). Writes the highest-authority
  // source='user' row — permanent: the background artist-identity task neither
  // re-resolves nor overwrites it (see upsertArtistIdentity / pendingArtistIdentityRows)
  // — then kicks a full rescan so the join tables re-bucket. Three shapes:
  //   { rawName, decision: 'single' }                  → keep the compound as one act
  //   { rawName, decision: 'split', members: [...] }   → split into the given artists
  //   { rawName, mergeInto }                           → spelling alias onto another artist
  //   { rawName, rename }                              → fix this artist's own spelling/name
  app.post('/artists/identity', async (c) => {
    requireCurator(c);
    const body = await c.req
      .json<{
        rawName?: string;
        decision?: 'single' | 'split';
        members?: string[];
        mergeInto?: string;
        rename?: string;
      }>()
      .catch(() => null);
    const rawName = body?.rawName?.trim();
    if (!rawName) return c.json({ error: 'rawName required' }, 400);
    const db = getDatabase();

    if (body?.rename != null) {
      // Rename this one artist to a corrected spelling/name. Unlike `mergeInto`
      // this deliberately ALLOWS an equal-normalized target — a diacritic/case fix
      // ("Los Áutenticos Decadentes" → "Los Auténticos Decadentes") keeps the same
      // artist id and just corrects the display name via `aliasFix` on rescan. A
      // different-normalized rename mints a new id (a full rename). Same alias write.
      const rename = body.rename.trim();
      if (!rename || rename === rawName) {
        return c.json({ error: 'rename must be a non-empty, different name' }, 400);
      }
      upsertArtistAlias(db, {
        aliasNorm: normalizeArtistForGrouping(rawName),
        canonicalName: rename,
        source: 'user',
      });
    } else if (body?.mergeInto != null) {
      const mergeInto = body.mergeInto.trim();
      if (
        !mergeInto ||
        normalizeArtistForGrouping(mergeInto) === normalizeArtistForGrouping(rawName)
      ) {
        return c.json({ error: 'mergeInto must be a different artist name' }, 400);
      }
      upsertArtistAlias(db, {
        aliasNorm: normalizeArtistForGrouping(rawName),
        canonicalName: mergeInto,
        source: 'user',
      });
    } else if (body?.decision === 'single') {
      upsertArtistIdentity(db, {
        artistKey: artistIdFor(rawName),
        rawName,
        decision: 'single',
        source: 'user',
      });
    } else if (body?.decision === 'split') {
      const members = (body.members ?? []).map((m) => m.trim()).filter(Boolean);
      if (members.length < 2) {
        return c.json({ error: 'split requires at least 2 member names' }, 400);
      }
      upsertArtistIdentity(db, {
        artistKey: artistIdFor(rawName),
        rawName,
        decision: 'split',
        members,
        source: 'user',
      });
    } else {
      return c.json({ error: 'decision (single|split), mergeInto, or rename required' }, 400);
    }

    // Re-bucket synchronously so the caller sees the change immediately (the UI
    // shows a spinner meanwhile). scan-cache skips unchanged files, so a no-op
    // rescan is cheap; the same await pattern backs POST /sync below.
    if (runSync) await runSync();
    recordAudit(db, c.get('user'), 'artist.identity', {
      targetKind: 'artist',
      targetId: rawName,
      detail: body?.rename
        ? `rename → ${body.rename.trim()}`
        : body?.mergeInto
          ? `merge → ${body.mergeInto.trim()}`
          : (body?.decision ?? ''),
    });
    return c.json({ ok: true, resynced: Boolean(runSync) });
  });

  // Artist-level genre override (issue #187 A3). This is the highest-leverage
  // correction surface in the library: one row fixes every track by an artist,
  // including ones downloaded later, and it is the only thing that actually
  // resolves cases MusicBrainz has no data for — measured 2/25 artists, so the
  // manual path is the primary path here, not a fallback.
  app.get('/artists/:id/genre', (c) => {
    const db = getDatabase();
    const artist = db
      .query<{ name: string }, [string]>(`SELECT name FROM library_artists WHERE id = ?`)
      .get(c.req.param('id'));
    if (!artist) return c.json({ error: 'Artist not found' }, 404);
    const key = normalizeArtistForGrouping(artist.name);
    const row = getGenreOverride(db, 'artist', key);
    // The genres actually in effect right now, so the modal can show provenance
    // ("from file tags" vs "set by you") rather than an unexplained list.
    const current = db
      .query<{ genre: string }, [string, string]>(
        `SELECT DISTINCT sg.genre FROM library_song_genres sg
           JOIN library_songs s ON s.id = sg.song_id
          WHERE s.artist_id = ? OR s.album_artist_id = ?
          ORDER BY sg.position`,
      )
      .all(c.req.param('id'), c.req.param('id'))
      .map((r) => r.genre);
    return c.json({
      artist: artist.name,
      current,
      override: row ? { genres: row.genres, source: row.source, note: row.note } : null,
    });
  });

  app.post('/artists/:id/genre', async (c) => {
    requireCurator(c);
    const db = getDatabase();
    const artist = db
      .query<{ name: string }, [string]>(`SELECT name FROM library_artists WHERE id = ?`)
      .get(c.req.param('id'));
    if (!artist) return c.json({ error: 'Artist not found' }, 404);

    const body = await c.req
      .json<{ genres?: string; note?: string }>()
      .catch(() => ({}) as { genres?: string; note?: string });
    const genres = splitStored(body.genres ?? '');
    if (genres.length === 0) return c.json({ error: 'genres is required' }, 400);

    upsertGenreOverride(db, {
      scope: 'artist',
      key: normalizeArtistForGrouping(artist.name),
      genres,
      source: 'user',
      mbid: null,
      confidence: null,
      status: 'applied',
      note: body.note?.trim() || null,
    });
    // Apply to the stored sets right away, then rescan synchronously — same
    // choice as the artist-identity route: the curator sees the corrected genre
    // immediately instead of wondering whether it took. The backfill matters on
    // its own because a scan of a large library takes minutes.
    backfillGenreOverrides(db, setSongGenres);
    if (runSync) await runSync();
    recordAudit(db, c.get('user'), 'artist.genre', {
      targetKind: 'artist',
      targetId: artist.name,
      detail: genres.join(';'),
    });
    return c.json({ ok: true, genres, resynced: Boolean(runSync) });
  });

  app.delete('/artists/:id/genre', async (c) => {
    requireCurator(c);
    const db = getDatabase();
    const artist = db
      .query<{ name: string }, [string]>(`SELECT name FROM library_artists WHERE id = ?`)
      .get(c.req.param('id'));
    if (!artist) return c.json({ error: 'Artist not found' }, 404);

    const removed = deleteGenreOverride(db, 'artist', normalizeArtistForGrouping(artist.name));
    // A reset needs the full rescan to rebuild the set from tags — the backfill
    // can only add an override's effect, never undo one.
    if (runSync) await runSync();
    recordAudit(db, c.get('user'), 'artist.genre', {
      targetKind: 'artist',
      targetId: artist.name,
      detail: 'reset',
    });
    return c.json({ ok: true, removed });
  });

  app.post('/sync', async (c) => {
    requireAdmin(c);
    if (!runSync) return c.json({ error: 'Sync not available' }, 503);
    await runSync();
    return c.json({ ok: true });
  });

  // Library fragmentation diagnostic. The detector runs over `library_albums`
  // and surfaces three classes of defects that turn "all my tracks are present"
  // into "but I can't find the album": same-release rows split across artist
  // spellings, rows hidden from the grid by `hidden`/`classification`, and
  // one-track-per-release mis-splits. The web's Admin panel and the CLI
  // `scripts/check-fragments.ts` both consume this — see `docs/library-scanner.md`.
  app.get('/fragments', (c) => {
    requireAdmin(c);
    return c.json(checkFragments(getDatabase()));
  });

  // --- Songs --------------------------------------------------------------------

  // Tokenized, accent-insensitive song autocomplete for pickers (e.g. the
  // playlist "add song" search box). Registered ahead of /songs/:id so the
  // literal "autocomplete" segment isn't ever shadowed by the param route.
  app.get('/songs/autocomplete', (c) => {
    const q = String(c.req.query('q') ?? '').trim();
    const limit = Math.min(Number(c.req.query('limit') ?? 8), 25);
    if (!q) return c.json([]);
    const tokens = tokenize(q);
    if (!tokens.length) return c.json([]);
    const db = getDatabase();
    const rows = db
      .query<SongRow, []>(`${SONG_SELECT} WHERE s.hidden = 0 AND s.landed_at IS NOT NULL`)
      .all();
    const songs = rows
      .filter((r) => matchesAllTokens(`${r.title} ${r.artist} ${r.album_name ?? ''}`, tokens))
      .sort(rankBy(tokens, (r) => r.title))
      .slice(0, limit)
      .map(rowToSong);
    attachSongArtists(db, songs);
    return c.json(songs);
  });

  app.get('/songs/:id', (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const row = db.query<SongRow, [string]>(`${SONG_SELECT} WHERE s.id = ?`).get(id);
    if (row) {
      const song = rowToSong(row);
      attachSongArtists(db, [song]);
      // Full genre set for the track-info sheet's chips (listings show primary).
      const genres = loadGenreSets(db, [id]).get(id);
      if (genres) song.genres = genres;
      return c.json(song);
    }
    return c.json({ error: 'Song not found' }, 404);
  });

  app.get('/songs/:id/provenance', async (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    interface ProvenanceRow {
      action: string;
      detail: string;
      applied_at: number;
    }
    const rows = db
      .query<ProvenanceRow, [string]>(
        `SELECT action, detail, applied_at
         FROM library_song_provenance
         WHERE navidrome_id = ?
         ORDER BY applied_at ASC`,
      )
      .all(id);
    return c.json(
      rows.map((r) => ({
        action: r.action,
        detail: JSON.parse(r.detail) as Record<string, unknown>,
        appliedAt: r.applied_at,
      })),
    );
  });

  // Acquisition provenance for a song (how/where-from/when it was acquired),
  // joined from the `acquisitions` side-table on the song's on-disk path. Returns
  // 404 for an unknown song and `null` for a song with no recorded provenance
  // (e.g. a legacy import the backfill couldn't resolve) so the UI degrades.
  app.get('/songs/:id/acquisition', (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const song = db
      .query<{ path: string }, [string]>(`SELECT path FROM library_songs WHERE id = ?`)
      .get(id);
    if (!song) return c.json({ error: 'Song not found' }, 404);
    return c.json(getAcquisitionByPath(db, song.path));
  });

  // On-demand BPM analysis. Returns an existing tag value immediately, otherwise
  // decodes + analyzes the audio, persists the result to library_songs.bpm AND
  // writes the tag back to the file so it survives rescans. 404 unknown song,
  // 503 when ffmpeg/analysis is unavailable.
  app.post('/songs/:id/analyze', async (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const song = db
      .query<{ path: string; bpm: number | null }, [string]>(
        `SELECT path, bpm FROM library_songs WHERE id = ?`,
      )
      .get(id);
    if (!song) return c.json({ error: 'Song not found' }, 404);

    if (song.bpm) return c.json({ bpm: song.bpm, source: 'tag' as const });
    if (!musicDir) return c.json({ error: 'Music directory not configured' }, 503);

    const abs = resolveSongPath(expandDir(musicDir), song.path);
    if (!isUnderMusicDir(expandDir(musicDir), abs) || !existsSync(abs)) {
      return c.json({ error: 'Song file not found' }, 404);
    }

    // The file's own BPM tag wins over re-analysis when present.
    const tags = await readAudioTags(abs);
    let bpm = tags.bpm ?? null;
    let source: 'tag' | 'analyzed' = 'tag';
    if (!bpm) {
      source = 'analyzed';
      // Sidecar first (Essentia): the local music-tempo fallback makes frequent
      // octave errors. A null/throwing sidecar falls through to the local path.
      if (audioFeaturesClient) {
        const r = await audioFeaturesClient.rhythm(song.path).catch(() => null);
        if (r) bpm = Math.round(r.bpm);
      }
      if (!bpm) bpm = await analyzeBpm(abs);
      if (bpm) {
        // Persist into the file so a future rescan reads it back.
        await writeAudioTags(abs, { bpm }).catch(() => false);
      }
    }
    if (!bpm) return c.json({ error: 'Could not determine BPM' }, 503);

    db.run('UPDATE library_songs SET bpm = ? WHERE id = ?', [bpm, id]);
    return c.json({ bpm, source });
  });

  // Genre verification against Lidarr/MusicBrainz. Read-only: returns the current
  // tag value, a suggested genre, and all candidates. `suggested` is null when
  // Lidarr is unconfigured or has nothing.
  app.get('/songs/:id/genre-suggestion', async (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const song = db
      .query<{ artist: string; genre: string | null }, [string]>(
        `SELECT artist, genre FROM library_songs WHERE id = ?`,
      )
      .get(id);
    if (!song) return c.json({ error: 'Song not found' }, 404);
    const result = await verifyGenre(lidarr, {
      artist: song.artist,
      currentGenre: song.genre,
    });
    return c.json(result);
  });

  // Apply a genre (or ';'-separated genre LIST, primary first) to a song
  // (admin): writes the full set to the file tag + library_song_genres, mirrors
  // the primary into library_songs, and refreshes library_genres counts so
  // search/grouping reflect it immediately.
  app.post('/songs/:id/genre', async (c) => {
    requireCurator(c);
    const id = c.req.param('id');
    const body = await c.req
      .json<{ genre?: string; mode?: 'append' | 'replace' }>()
      .catch(() => ({}) as { genre?: string; mode?: 'append' | 'replace' });
    const genres = (body.genre ?? '')
      .split(/[;,|]/)
      .map((g) => g.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
    if (genres.length === 0) return c.json({ error: 'genre is required' }, 400);

    const db = getDatabase();
    const song = db
      .query<{ path: string; genre: string | null }, [string]>(
        `SELECT path, genre FROM library_songs WHERE id = ?`,
      )
      .get(id);
    if (!song) return c.json({ error: 'Song not found' }, 404);

    // Default 'append': a detected genre adds to, never clobbers, the song's
    // other genres — existing callers and behaviour are unchanged. 'replace'
    // (issue #187 A3) writes a song-scoped user override so the set's PRIMARY
    // becomes these genres and stays that way across rescans; the tag mirror
    // below is then a convenience for external players, not the durability
    // mechanism.
    if (body.mode === 'replace') {
      upsertGenreOverride(db, {
        scope: 'song',
        key: id,
        genres,
        source: 'user',
        mbid: null,
        confidence: null,
        status: 'applied',
        note: null,
      });
    }
    let merged: string[];
    if (body.mode === 'replace') {
      // Mirror what buildLibrary will compute on the next scan (override first,
      // then the tag genres it doesn't already carry) so the UI and the eventual
      // scan agree instead of briefly disagreeing.
      const existing = loadGenreSets(db, [id]).get(id) ?? [];
      merged = applyGenreOverride(
        buildOverrideIndex([
          {
            scope: 'song',
            key: id,
            genres,
            source: 'user',
            mbid: null,
            confidence: null,
            status: 'applied',
            note: null,
          },
        ]),
        { songId: id, albumKey: '', artistKey: '' },
        existing,
      );
      setSongGenres(db, id, merged);
    } else {
      merged = appendSongGenres(db, id, genres);
    }
    if (musicDir) {
      const abs = resolveSongPath(expandDir(musicDir), song.path);
      if (isUnderMusicDir(expandDir(musicDir), abs) && existsSync(abs)) {
        await writeAudioTags(abs, { genre: merged.join('; ') }).catch(() => false);
      }
    }
    return c.json({ ok: true, genre: merged[0], genres: merged });
  });

  // Detect a licence for a song (read-only). The file's own LICENSE/COPYRIGHT tag
  // wins (source 'tag', zero network); otherwise a MusicBrainz `license`
  // url-relation lookup (source 'musicbrainz'). `suggested` is null when nothing
  // is confidently found — MB licence coverage is sparse, so this is expected.
  app.get('/songs/:id/licence-suggestion', async (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const song = db
      .query<{ path: string; artist: string; title: string; licence: string | null }, [string]>(
        `SELECT path, artist, title, licence FROM library_songs WHERE id = ?`,
      )
      .get(id);
    if (!song) return c.json({ error: 'Song not found' }, 404);

    let suggested: string | null = null;
    let source: 'tag' | 'musicbrainz' | null = null;
    if (musicDir) {
      const abs = resolveSongPath(expandDir(musicDir), song.path);
      if (isUnderMusicDir(expandDir(musicDir), abs) && existsSync(abs)) {
        const tags = await readAudioTags(abs).catch(
          () => ({}) as Awaited<ReturnType<typeof readAudioTags>>,
        );
        if (tags.licence) {
          suggested = tags.licence;
          source = 'tag';
        } else {
          const mb = getMbLicenceClient(dataDir);
          if (mb) {
            const code = await mb
              .getLicence({
                mbRecordingId: tags.mbRecordingId,
                mbReleaseId: tags.mbReleaseId,
                artist: song.artist,
                title: song.title,
              })
              .catch(() => null);
            if (code) {
              suggested = code;
              source = 'musicbrainz';
            }
          }
        }
      }
    }
    return c.json({ current: song.licence, suggested, source });
  });

  // Set (or clear) a song's licence (curator). An empty value or 'unknown' clears
  // it (stores SQL NULL so the background task can re-resolve); a valid
  // LICENCE_VOCAB code is stored, marked licence_source='user' (so the task never
  // overrides it), and mirrored to the file's LICENSE tag so a rescan preserves it.
  app.post('/songs/:id/licence', async (c) => {
    requireCurator(c);
    const id = c.req.param('id');
    const body = await c.req.json<{ licence?: string }>().catch(() => ({}) as { licence?: string });
    const raw = (body.licence ?? '').trim().toLowerCase();
    const clear = raw === '' || raw === 'unknown';
    if (!clear && !isLicenceCode(raw)) return c.json({ error: 'invalid licence' }, 400);

    const db = getDatabase();
    const song = db
      .query<{ path: string }, [string]>(`SELECT path FROM library_songs WHERE id = ?`)
      .get(id);
    if (!song) return c.json({ error: 'Song not found' }, 404);

    const value = clear ? null : raw;
    db.run('UPDATE library_songs SET licence = ?, licence_source = ? WHERE id = ?', [
      value,
      value ? 'user' : null,
      id,
    ]);
    if (value && musicDir) {
      const abs = resolveSongPath(expandDir(musicDir), song.path);
      if (isUnderMusicDir(expandDir(musicDir), abs) && existsSync(abs)) {
        await writeAudioTags(abs, { licence: value }).catch(() => false);
      }
    }
    recordAudit(db, c.get('user'), 'song.licence', {
      targetKind: 'song',
      targetId: id,
      detail: value ?? 'cleared',
    });
    return c.json({ ok: true, licence: value });
  });

  // Stored lyrics for a song (any user — the library is shared). Returns the
  // LyricsDto or `null` when none have been fetched yet; 404 for an unknown song.
  app.get('/songs/:id/lyrics', (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const song = db
      .query<{ id: string }, [string]>(`SELECT id FROM library_songs WHERE id = ?`)
      .get(id);
    if (!song) return c.json({ error: 'Song not found' }, 404);
    return c.json(getLyrics(db, id));
  });

  // On-demand lyrics fetch (any user — LRCLIB is keyless/benign). Returns a
  // non-customized cached row immediately; otherwise queries each enabled
  // lyrics-capable plugin, persists the first hit, writes the plain text back to
  // the file tag, and returns it. A user-edited row (customized=1) is left
  // untouched unless `force:true`. 503 when no lyrics source is enabled.
  app.post('/songs/:id/lyrics/fetch', async (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const song = db
      .query<
        { path: string; title: string; artist: string; duration: number; album: string | null },
        [string]
      >(
        `SELECT s.path, s.title, s.artist, s.duration, a.name AS album
         FROM library_songs s LEFT JOIN library_albums a ON a.id = s.album_id
         WHERE s.id = ?`,
      )
      .get(id);
    if (!song) return c.json({ error: 'Song not found' }, 404);

    const body = await c.req.json<{ force?: boolean }>().catch(() => ({}) as { force?: boolean });
    // Return any cached row as-is unless an explicit re-fetch is requested; this
    // both serves repeat opens cheaply and protects user-edited (customized) rows.
    const existing = getLyrics(db, id);
    if (existing && !body.force) return c.json(existing);

    // No DB row: recover lyrics embedded in the file tag before hitting a source.
    // A transcode/move changes the path-derived songId and orphans the side-table
    // row, but the plain text was written into the tag, so it travels with the file.
    if (!existing && musicDir) {
      const abs = resolveSongPath(expandDir(musicDir), song.path);
      if (isUnderMusicDir(expandDir(musicDir), abs) && existsSync(abs)) {
        const tags = await readAudioTags(abs).catch(() => null);
        if (tags?.lyrics) {
          return c.json(
            setLyrics(db, id, {
              plain: tags.lyrics,
              synced: null,
              source: 'file-tag',
              customized: false,
            }),
          );
        }
      }
    }

    if (!pluginRegistry?.hasCapability('lyrics')) {
      return c.json({ error: 'No lyrics source enabled' }, 503);
    }

    const query = {
      title: song.title,
      artist: song.artist,
      album: song.album ?? undefined,
      durationSec: song.duration || undefined,
    };
    // Track whether a source *failed* (threw) vs cleanly reported "no match", so
    // a transient LRCLIB error (rate-limit / 5xx / timeout) doesn't masquerade as
    // a confident "no lyrics" — the client shows a retry instead of a false empty.
    let sourceErrored = false;
    for (const plugin of pluginRegistry.getEnabledWithCapability('lyrics')) {
      const result = await plugin.lyrics?.fetchLyrics(query).catch(() => {
        sourceErrored = true;
        return null;
      });
      if (!result) continue;
      const saved = setLyrics(db, id, {
        plain: result.plain,
        synced: result.synced,
        source: result.source,
        customized: false,
      });
      if (result.plain && musicDir) {
        const abs = resolveSongPath(expandDir(musicDir), song.path);
        if (isUnderMusicDir(expandDir(musicDir), abs) && existsSync(abs)) {
          await writeAudioTags(abs, { lyrics: result.plain }).catch(() => false);
        }
      }
      return c.json(saved);
    }
    // No match anywhere. Distinguish an authoritative miss (null) from a source
    // failure (502) so the UI can offer "try again" rather than "no lyrics".
    if (sourceErrored) {
      return c.json({ error: 'Lyrics source unavailable' }, 502);
    }
    return c.json(null);
  });

  // Save user-edited lyrics (admin): marks the row customized so a re-fetch won't
  // clobber it, clears the synced LRC (the edited body no longer matches its
  // timing), and writes the plain text back to the file tag.
  app.put('/songs/:id/lyrics', async (c) => {
    requireCurator(c);
    const id = c.req.param('id');
    const body = await c.req.json<{ plain?: string }>().catch(() => ({}) as { plain?: string });
    const plain = (body.plain ?? '').trim();
    if (!plain) return c.json({ error: 'plain is required' }, 400);

    const db = getDatabase();
    const song = db
      .query<{ path: string }, [string]>(`SELECT path FROM library_songs WHERE id = ?`)
      .get(id);
    if (!song) return c.json({ error: 'Song not found' }, 404);

    const saved = setLyrics(db, id, { plain, synced: null, source: 'user', customized: true });
    if (musicDir) {
      const abs = resolveSongPath(expandDir(musicDir), song.path);
      if (isUnderMusicDir(expandDir(musicDir), abs) && existsSync(abs)) {
        await writeAudioTags(abs, { lyrics: plain }).catch(() => false);
      }
    }
    return c.json(saved);
  });

  // Reset lyrics (admin): drops the stored row. Leaves any embedded file tag in
  // place (rewriting a file to strip a tag is risky and low-value).
  app.delete('/songs/:id/lyrics', (c) => {
    requireCurator(c);
    const id = c.req.param('id');
    const db = getDatabase();
    deleteLyrics(db, id);
    return c.json({ ok: true });
  });

  app.get('/songs/:id/similar', async (c) => {
    const id = c.req.param('id');
    const size = Math.min(Number(c.req.query('size') ?? 20), 50);
    const db = getDatabase();

    const source = db.query<SongRow, [string]>(`${SONG_SELECT} WHERE s.id = ?`).get(id);
    if (!source) return c.json({ error: 'Song not found' }, 404);

    const seed: SongFeatures = songRowFeatures(source);

    // Build candidate pool: same-artist + same-genre songs
    const candidateRows: SongRow[] = [];
    const seen = new Set<string>([id]);

    const artistSongs = db
      .query<SongRow, [string]>(
        `${SONG_SELECT} WHERE s.artist_id = ? AND s.hidden = 0 AND s.landed_at IS NOT NULL`,
      )
      .all(source.artist_id);
    for (const row of artistSongs) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        candidateRows.push(row);
      }
    }

    // Pool on ANY shared genre (full set), not just the primary column.
    const seedGenres = loadGenreSets(db, [id]).get(id) ?? (source.genre ? [source.genre] : []);
    seed.genres = seedGenres.length > 0 ? seedGenres : undefined;
    if (seedGenres.length > 0) {
      const marks = seedGenres.map(() => '?').join(', ');
      const genreRows = db
        .query<SongRow, string[]>(
          `${SONG_SELECT} WHERE (s.genre IN (${marks}) OR EXISTS (
             SELECT 1 FROM library_song_genres g WHERE g.song_id = s.id AND g.genre IN (${marks})
           )) AND s.artist_id != ? AND s.hidden = 0 AND s.landed_at IS NOT NULL
           ORDER BY RANDOM() LIMIT 200`,
        )
        .all(...seedGenres, ...seedGenres, source.artist_id);
      for (const row of genreRows) {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          candidateRows.push(row);
        }
      }
    }

    // Attach cached embeddings so the scorer's cosine axis engages when present
    // (no-op when the seed has no embedding — comparison needs both sides).
    const model = embeddingModelFor(db, id);
    const embeddings = model
      ? loadEmbeddings(db, [id, ...candidateRows.map((r) => r.id)], model)
      : new Map<string, Float32Array>();
    seed.embedding = embeddings.get(id);

    const candidateGenres = loadGenreSets(
      db,
      candidateRows.map((r) => r.id),
    );
    const candidates = candidateRows.map((r) => ({
      ...songRowFeatures(r),
      genres: candidateGenres.get(r.id),
      embedding: embeddings.get(r.id),
      _row: r,
    }));

    // Use a higher artist cap for "similar" than for radio — same-artist results
    // are expected here — and a small NORMALIZED-space boost (scores are 0..1)
    // so same-artist tracks are nudged up rather than penalized.
    const ranked = rankCandidates(seed, candidates, {
      count: size,
      maxPerArtist: 5,
      weights: { ...DEFAULT_WEIGHTS, artistPenalty: -0.1 },
    });

    const results = ranked.map((e) => rowToSong((e.song as (typeof candidates)[number])._row));
    attachSongArtists(db, results);

    return c.json(results);
  });

  app.get('/genres', (c) => {
    const db = getDatabase();
    const rows = db
      .query<{ name: string; song_count: number; album_count: number }, []>(
        `SELECT name, song_count, album_count FROM library_genres ORDER BY song_count DESC`,
      )
      .all();
    return c.json(
      rows.map((r) => ({ value: r.name, songCount: r.song_count, albumCount: r.album_count })),
    );
  });

  app.get('/genres/songs', (c) => {
    const genre = c.req.query('genre') ?? '';
    // Cap is high enough to enumerate a full genre for the offline "Download"
    // flow; the client-side storage budget is the real limiter.
    const count = Math.min(Number(c.req.query('count') ?? 100), 10000);
    if (!genre) return c.json([]);
    const db = getDatabase();
    const rows = db
      .query<SongRow, [string, number]>(
        `${SONG_SELECT} WHERE s.genre = ? AND s.hidden = 0 AND s.landed_at IS NOT NULL
         ORDER BY s.created DESC NULLS LAST LIMIT ?`,
      )
      .all(genre, count);
    const songs = rows.map(rowToSong);
    attachSongArtists(db, songs);
    return c.json(songs);
  });

  app.get('/random', (c) => {
    const size = Math.min(Number(c.req.query('size') ?? 10), 200);
    const db = getDatabase();
    const rows = db
      .query<SongRow, [number]>(
        `${SONG_SELECT}
         LEFT JOIN library_albums alb ON alb.id = s.album_id
         WHERE s.hidden = 0 AND s.landed_at IS NOT NULL AND (alb.hidden IS NULL OR alb.hidden = 0)
         ORDER BY RANDOM() LIMIT ?`,
      )
      .all(size);
    const songs = rows.map(rowToSong);
    attachSongArtists(db, songs);
    return c.json(songs);
  });

  // Whole-library flat songs listing — powers the Library "Songs" tab. Mirrors
  // /artists/:id/songs (same LibraryFilter grammar + sort whitelist) but without
  // the artist predicate, so it filters/sorts/paginates the entire landed library.
  app.get('/songs', (c) => {
    const size = Math.min(Number(c.req.query('size') ?? 60), 200);
    const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);
    const sort = c.req.query('sort') ?? 'newest';
    const q = String(c.req.query('q') ?? '').trim();
    const db = getDatabase();
    const wheres = [
      's.hidden = 0',
      // Quarantined songs aren't in the library yet — exclude, same as the artist tab.
      's.landed_at IS NOT NULL',
      '(a.hidden IS NULL OR a.hidden = 0)',
    ];
    const params: Array<string | number> = [];
    if (q) {
      // Free-text search across song title, song artist, and album name. LIKE
      // special characters are escaped so a query like "50%" is a literal
      // search, not a wildcard — the matching `%` we wrap with for partial
      // matching is unrelated.
      const escaped = q.replace(/[\\%_]/g, (m) => '\\' + m);
      const like = `%${escaped}%`;
      wheres.push(
        `(s.title LIKE ? ESCAPE '\\' OR s.artist LIKE ? ESCAPE '\\' OR a.name LIKE ? ESCAPE '\\') COLLATE NOCASE`,
      );
      params.push(like, like, like);
    }
    const frag = songFilterWheres(parseLibraryFilter(c.req.queries()), 's');
    wheres.push(...frag.wheres);
    params.push(...frag.params);
    const rows = db
      .query<SongRow, (string | number)[]>(
        `${SONG_SELECT} WHERE ${wheres.join(' AND ')}
         ORDER BY ${songOrderBy(sort)} LIMIT ? OFFSET ?`,
      )
      .all(...params, size, offset);
    const songs = rows.map(rowToSong);
    attachSongArtists(db, songs);
    return c.json(songs);
  });

  // Recently added — uses completed_downloads history to surface user's most-recent imports.
  app.get('/recent-songs', (c) => {
    const size = Math.min(Number(c.req.query('size') ?? 50), 200);
    const db = getDatabase();
    const rows = db
      .query<SongRow, [number]>(
        `${SONG_SELECT}
         WHERE s.hidden = 0 AND s.landed_at IS NOT NULL AND (a.hidden IS NULL OR a.hidden = 0)
         ORDER BY s.created DESC NULLS LAST LIMIT ?`,
      )
      .all(size * 4);
    const baseSongs = rows.map(rowToSong);
    attachSongArtists(db, baseSongs);
    const songs = baseSongs.map((s, i) => ({
      ...s,
      albumName: rows[i].album_name ?? '',
      albumArtist: rows[i].artist,
    }));
    const ordered = orderByCompletionHistory(songs);
    return c.json(ordered.slice(0, size));
  });

  function tokenizeFilename(name: string): string[] {
    return name
      .toLowerCase()
      .replace(/\.[^.]+$/, '')
      .split(/[\s\-_.]+/)
      .filter((t) => t.length >= 2);
  }

  function findFileByTokens(dir: string, tokens: string[]): string | null {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    const tokenSet = new Set(tokens);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (tokenizeFilename(entry.name).some((t) => tokenSet.has(t))) {
        return join(dir, entry.name);
      }
    }
    return null;
  }

  function fuzzyFindFile(musicRootDir: string, fullPath: string): string | null {
    const tokens = tokenizeFilename(basename(fullPath));
    if (tokens.length === 0) return null;

    const knownDir = dirname(fullPath);
    if (existsSync(knownDir)) {
      const found = findFileByTokens(knownDir, tokens);
      if (found) return found;
    }

    let rootEntries: import('node:fs').Dirent[];
    try {
      rootEntries = readdirSync(musicRootDir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const topEntry of rootEntries) {
      if (!topEntry.isDirectory()) continue;
      const topDir = join(musicRootDir, topEntry.name);
      const found = findFileByTokens(topDir, tokens);
      if (found) return found;
      // search one level deeper to cover the standard Artist/Album/track layout
      let subEntries: import('node:fs').Dirent[];
      try {
        subEntries = readdirSync(topDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const subEntry of subEntries) {
        if (!subEntry.isDirectory()) continue;
        const subFound = findFileByTokens(join(topDir, subEntry.name), tokens);
        if (subFound) return subFound;
      }
    }

    return null;
  }

  async function deleteOne(id: string): Promise<{ ok: boolean; error?: string; status?: number }> {
    if (!musicDir) {
      return { ok: false, error: 'Music directory not configured', status: 500 };
    }

    const db = getDatabase();
    const canonical = db
      .query<{ path: string }, [string]>(`SELECT path FROM library_songs WHERE id = ?`)
      .get(id);
    const songPath: string | null = canonical?.path ?? null;
    if (!songPath) {
      return { ok: false, error: 'Song not found in library', status: 404 };
    }

    const expandedMusicDir = expandDir(musicDir);
    const fullPath = resolveSongPath(expandedMusicDir, songPath);

    if (!isUnderMusicDir(expandedMusicDir, fullPath)) {
      log.warn(
        { path: fullPath, musicDir: expandedMusicDir },
        'Resolved song path is outside the music directory',
      );
      return { ok: false, error: 'Song path is outside the music directory', status: 400 };
    }

    let deletedPath: string | null = null;

    if (existsSync(fullPath)) {
      try {
        unlinkSync(fullPath);
        deletedPath = fullPath;
        log.info({ path: fullPath, songId: id }, 'Deleted song file from disk');
      } catch (err) {
        log.error({ err, path: fullPath }, 'Failed to delete song file');
        return { ok: false, error: 'Failed to delete file', status: 500 };
      }
    } else {
      const registeredRelPath = lookupDownloadPath(id);
      const fileBasename = basename(fullPath).toLowerCase();
      const relPath = registeredRelPath ?? lookupDownloadPathByBasename(fileBasename);
      const fallbackPath = relPath ? join(expandedMusicDir, relPath) : null;
      if (fallbackPath && existsSync(fallbackPath)) {
        try {
          unlinkSync(fallbackPath);
          deletedPath = fallbackPath;
          log.info(
            { requestedPath: fullPath, resolvedPath: fallbackPath },
            'Deleted song file via fallback path',
          );
        } catch (err) {
          log.error({ err, path: fallbackPath }, 'Failed to delete song file');
          return { ok: false, error: 'Failed to delete file', status: 500 };
        }
      } else {
        const fuzzyPath = fuzzyFindFile(expandedMusicDir, fullPath);
        if (fuzzyPath) {
          try {
            unlinkSync(fuzzyPath);
            deletedPath = fuzzyPath;
            log.info(
              { requestedPath: fullPath, resolvedPath: fuzzyPath },
              'Deleted song file via fuzzy path match',
            );
          } catch (err) {
            log.error({ err, path: fuzzyPath }, 'Failed to delete song file');
            return { ok: false, error: 'Failed to delete file', status: 500 };
          }
        } else {
          log.warn(
            { songId: id, expectedPath: fullPath },
            'Song file not found on disk; no fallback path resolved',
          );
          // File is already gone — clean up the orphaned DB record so it stops appearing in Navidrome.
          const orphan = db
            .query<{ id: string }, [string]>(`SELECT id FROM library_songs WHERE id = ?`)
            .get(id);
          if (orphan) {
            try {
              db.run('DELETE FROM completed_downloads WHERE navidrome_id = ?', [id]);
              db.run('DELETE FROM library_songs WHERE id = ?', [id]);
            } catch (err) {
              log.debug({ err }, 'Failed to remove orphaned record');
            }
            // The file was already gone from disk but slskd may not know yet —
            // rescan so it stops advertising it.
            shareRescan.schedule();
            return { ok: true };
          }
          return { ok: false, error: 'Song file not found on disk', status: 404 };
        }
      }
    }

    if (deletedPath) {
      shareRescan.schedule();
      cleanupEmptyDirs(deletedPath, expandedMusicDir);
      const relPath = relative(expandedMusicDir, deletedPath).replace(/\\/g, '/');

      try {
        db.run('DELETE FROM completed_downloads WHERE navidrome_id = ? OR relative_path = ?', [
          id,
          relPath,
        ]);
        db.run('DELETE FROM library_songs WHERE id = ?', [id]);
        log.info({ relPath }, 'Removed song from completion history + canonical DB');
      } catch (err) {
        log.debug({ err }, 'Failed to remove from completion history');
      }
    }

    return { ok: true };
  }

  app.delete('/songs/:id', async (c) => {
    requireCurator(c);

    const result = await deleteOne(c.req.param('id'));
    if (!result.ok) {
      return c.json({ error: result.error }, (result.status ?? 500) as 400 | 404 | 500);
    }

    if (runSync) void runSync();

    return c.json({ ok: true });
  });

  app.post('/songs/bulk-delete', async (c) => {
    requireCurator(c);

    const { ids } = await c.req.json<{ ids: string[] }>();
    if (!ids || !Array.isArray(ids)) {
      return c.json({ error: 'IDs array required' }, 400);
    }

    log.info({ count: ids.length }, 'Bulk deleting songs');
    const results = await Promise.allSettled(ids.map((id) => deleteOne(id)));

    const failed = results.filter(
      (r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok),
    );
    if (failed.length === ids.length) {
      const firstError = results.find((r) => r.status === 'fulfilled' && !r.value.ok) as
        PromiseFulfilledResult<{ ok: false; error: string; status: number }> | undefined;
      const status = firstError?.value.status ?? 500;
      return c.json(
        { error: firstError?.value.error ?? 'Failed to delete any songs' },
        status as 400 | 404 | 500,
      );
    }

    if (runSync) void runSync();

    recordAudit(getDatabase(), c.get('user'), 'songs.bulk-delete', {
      targetKind: 'songs',
      detail: `${ids.length - failed.length}/${ids.length} deleted`,
    });
    return c.json({ ok: true, deletedCount: ids.length - failed.length });
  });

  // Duplicate detection — now reads entirely from canonical DB.
  app.get('/duplicates', (c) => {
    requireAdmin(c);

    const db = getDatabase();
    const rows = db
      .query<SongRow, []>(
        `${SONG_SELECT} WHERE s.hidden = 0 AND (a.hidden IS NULL OR a.hidden = 0)`,
      )
      .all();
    const allSongs = rows.map(rowToSong);

    const groups = new Map<string, Song[]>();
    for (const song of allSongs) {
      const key = normalizeDupKey(song.title, song.artist);
      const group = groups.get(key) ?? [];
      group.push(song);
      groups.set(key, group);
    }

    const duplicates: Array<
      Array<{
        id: string;
        title: string;
        artist: string;
        album: string;
        duration?: number;
        bitRate?: number;
        suffix?: string;
        path: string;
        coverArt?: string;
      }>
    > = [];

    for (const [, group] of groups) {
      if (group.length < 2) continue;

      const clusters: Song[][] = [];
      for (const song of group) {
        let placed = false;
        for (const cluster of clusters) {
          const refDur = cluster[0]?.duration ?? 0;
          if (Math.abs((song.duration ?? 0) - refDur) <= 2) {
            cluster.push(song);
            placed = true;
            break;
          }
        }
        if (!placed) clusters.push([song]);
      }

      for (const cluster of clusters) {
        if (cluster.length < 2) continue;
        duplicates.push(
          cluster
            .sort((a, b) => qualityScore(b) - qualityScore(a))
            .map((s) => ({
              id: s.id,
              title: s.title,
              artist: s.artist,
              album: s.album,
              duration: s.duration,
              bitRate: s.bitRate,
              suffix: s.suffix,
              path: s.path,
              coverArt: s.coverArt,
            })),
        );
      }
    }

    return c.json(duplicates);
  });

  return app;
}

interface DownloadHistoryRow {
  relative_path: string | null;
  basename: string;
  completed_at: number;
}

function orderByCompletionHistory<T extends { path: string; created?: string; title: string }>(
  songs: T[],
): T[] {
  const byPath = new Map<string, number>();
  const byBasename = new Map<string, number>();

  try {
    const db = getDatabase();
    const rows = db
      .query<DownloadHistoryRow, []>(
        `SELECT relative_path, basename, completed_at
         FROM completed_downloads
         ORDER BY completed_at DESC
         LIMIT 5000`,
      )
      .all();

    for (const row of rows) {
      if (row.relative_path) {
        const normalizedPath = normalizePath(row.relative_path);
        if (!byPath.has(normalizedPath)) {
          byPath.set(normalizedPath, row.completed_at);
        }
      }
      const normalizedBasename = row.basename.toLowerCase();
      if (!byBasename.has(normalizedBasename)) {
        byBasename.set(normalizedBasename, row.completed_at);
      }
    }
  } catch {
    // DB not initialized — fallback ordering still applies.
  }

  const scored = songs.map((song) => {
    const normalizedSongPath = normalizePath(song.path);
    const normalizedSongBase = basename(normalizedSongPath).toLowerCase();
    const completedAt = byPath.get(normalizedSongPath) ?? byBasename.get(normalizedSongBase) ?? 0;
    const createdAt = parseCreatedAt(song.created);
    return { song, completedAt, createdAt };
  });

  scored.sort((a, b) => {
    if (a.completedAt !== b.completedAt) return b.completedAt - a.completedAt;
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
    return a.song.title.localeCompare(b.song.title);
  });

  return scored.map((entry) => entry.song);
}

function normalizePath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

function normalizeDupKey(title: string, artist: string): string {
  return `${title}|||${artist}`
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function qualityScore(song: Song): number {
  const ext = (song.suffix ?? '').toLowerCase();
  const formatScore =
    ext === 'flac' || ext === 'wav' || ext === 'aiff' || ext === 'ape' || ext === 'wv'
      ? 200
      : ext === 'opus' || ext === 'ogg' || ext === 'm4a' || ext === 'aac'
        ? 100
        : 0;
  return formatScore + (song.bitRate ?? 0);
}

function parseCreatedAt(created?: string): number {
  if (!created) return 0;
  const parsed = Date.parse(created);
  return Number.isFinite(parsed) ? parsed : 0;
}

function expandDir(dir: string): string {
  if (dir.startsWith('~')) {
    return join(process.env.HOME ?? '/root', dir.slice(1));
  }
  return dir;
}

function resolveSongPath(musicDir: string, songPath: string): string {
  const normalizedSongPath = songPath.replace(/\\/g, '/');

  if (isAbsolutePath(normalizedSongPath)) {
    return normalize(normalizedSongPath);
  }

  return normalize(join(musicDir, normalizedSongPath));
}

function lookupDownloadPath(navidromeId: string): string | null {
  try {
    const row = getDatabase()
      .query<{ relative_path: string }, [string]>(
        `SELECT relative_path FROM completed_downloads
         WHERE navidrome_id = ? AND relative_path IS NOT NULL LIMIT 1`,
      )
      .get(navidromeId);
    return row?.relative_path ?? null;
  } catch {
    return null;
  }
}

function lookupDownloadPathByBasename(fileBasename: string): string | null {
  try {
    const row = getDatabase()
      .query<{ relative_path: string }, [string]>(
        `SELECT relative_path FROM completed_downloads
         WHERE basename = ? AND relative_path IS NOT NULL
         ORDER BY completed_at DESC LIMIT 1`,
      )
      .get(fileBasename);
    return row?.relative_path ?? null;
  } catch {
    return null;
  }
}

function isUnderMusicDir(musicDir: string, candidatePath: string): boolean {
  const rel = relative(musicDir, candidatePath);
  return rel !== '' && !rel.startsWith('..');
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:\//.test(path);
}

/**
 * Recursively delete an album's folder when it's safe to do so — the reliable
 * path for "Remove album" since it takes cover art and sidecar files (.nfo,
 * cover.jpg) with it, which per-file deletion leaves behind for Navidrome to
 * re-index. Returns false (caller falls back to per-file deletion) unless the
 * songs all share one album-specific directory that contains nothing foreign.
 */
function tryDeleteAlbumFolder(songFullPaths: string[], expandedMusicDir: string): boolean {
  if (songFullPaths.length === 0) return false;

  const normalizedMusicDir = normalize(expandedMusicDir);
  const dirs = new Set(songFullPaths.map((p) => dirname(p)));
  if (dirs.size !== 1) return false; // multi-disc / scattered — let per-file handle it
  const dir = normalize([...dirs][0]!);

  // Must be album-specific: at least <Artist>/<Album> below the music root, and
  // never a shared "Singles" bucket.
  const rel = relative(normalizedMusicDir, dir);
  if (rel === '' || rel.startsWith('..')) return false;
  if (rel.split(/[\\/]/).filter(Boolean).length < 2) return false;
  if (basename(dir).toLowerCase() === 'singles') return false;

  // Refuse if the folder holds anything we didn't expect — a foreign audio file
  // (another album sharing the dir) or a subdirectory.
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  const albumFiles = new Set(songFullPaths.map((p) => normalize(p)));
  for (const entry of entries) {
    if (entry.isDirectory()) return false;
    if (!entry.isFile()) continue;
    const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
    if (AUDIO_EXTENSIONS.has(ext) && !albumFiles.has(normalize(join(dir, entry.name)))) {
      return false; // foreign audio — don't take it down with this album
    }
  }

  try {
    rmSync(dir, { recursive: true, force: true });
    log.info({ dir }, 'Removed album folder');
    cleanupEmptyDirs(dir, normalizedMusicDir); // climb to drop an now-empty <Artist>
    return true;
  } catch (err) {
    log.error({ err, dir }, 'Failed to remove album folder');
    return false;
  }
}

function cleanupEmptyDirs(filePath: string, musicDir: string): void {
  const normalizedMusicDir = normalize(musicDir);
  let dir = dirname(filePath);
  while (true) {
    const normalizedDir = normalize(dir);
    if (normalizedDir === normalizedMusicDir || !normalizedDir.startsWith(normalizedMusicDir))
      break;
    try {
      if (readdirSync(normalizedDir).length === 0) {
        rmdirSync(normalizedDir);
        log.info({ dir: normalizedDir }, 'Removed empty directory after song deletion');
        dir = dirname(normalizedDir);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}
