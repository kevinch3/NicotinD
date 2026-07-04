import { Hono } from 'hono';
import { basename, dirname, join, normalize, relative } from 'node:path';
import { unlinkSync, rmdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { createLogger } from '@nicotind/core';
import type { Song, Album, Artist } from '@nicotind/core';
import type { Lidarr } from '@nicotind/lidarr-client';
import type { AuthEnv } from '../middleware/auth.js';
import type { Database } from 'bun:sqlite';
import { getDatabase } from '../db.js';
import type { LibraryCurator } from '../services/library-curator.js';
import { normalizeArtistForGrouping, normalizeForGrouping } from '../services/album-grouping.js';
import { transferGroupKeys } from '../services/transfer-group-keys.js';
import type { SlskdRef } from '../index.js';
import { getAcquisitionByPath } from '../services/acquisition-store.js';
import { analyzeBpm, verifyGenre } from '../services/track-analysis.js';
import { readAudioTags, writeAudioTags } from '../services/audio-tags.js';
import { getLyrics, setLyrics, deleteLyrics } from '../services/lyrics-store.js';
import type { PluginRegistry } from '../services/plugins/registry.js';
import { optimizeAlbum } from '../services/metadata-optimize.js';
import { rankCandidates, DEFAULT_WEIGHTS, type SongFeatures } from '../services/radio.service.js';
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
import {
  dedupeCoverUrls,
  selectDistinctEmbeddedCovers,
  extractEmbeddedPicture,
  writeFolderCover,
} from '../services/cover-sources.js';
import { pruneOrphanArtist } from '../services/library-aggregates.js';
import { songOrderBy } from '../services/song-sort.js';
import { attachSongArtists, attachAlbumArtists } from '../services/artist-attach.js';
import type {
  ApplyMetadataRequest,
  AlbumCoverCandidate,
  CoverCandidatesResponse,
  ApplyCoverRequest,
} from '@nicotind/core';

const log = createLogger('library');

const VALID_CLASSIFICATIONS = new Set(['album', 'ep', 'single', 'compilation', 'unknown']);

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
  const jobs = db
    .query<{ artist_name: string; album_title: string }, []>(
      `SELECT artist_name, album_title FROM album_jobs
       WHERE state = 'active' AND artist_name IS NOT NULL AND album_title IS NOT NULL`,
    )
    .all();
  const keys = new Set(extraKeys);
  for (const j of jobs) {
    keys.add(`${normalizeArtistForGrouping(j.artist_name)} ${normalizeForGrouping(j.album_title)}`);
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
         year, genre, created, starred, classification, hidden, manual_override
  FROM library_albums
`;

const SONG_SELECT = `
  SELECT s.id, s.album_id, a.name AS album_name, a.cover_art AS album_cover_art,
         s.title, s.artist, s.artist_id, s.album_artist, s.album_artist_id,
         s.track, s.duration, s.year, s.genre,
         s.cover_art, s.path, s.size, s.bit_rate, s.suffix, s.content_type,
         s.created, s.starred, s.bpm, s.key,
         s.energy, s.loudness, s.valence, s.danceability, s.acousticness,
         s.instrumental, s.mood
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
  const { curator, runSync, lidarr, coverCacheDir, dataDir, pluginRegistry } = options;

  app.get('/artists', (c) => {
    const db = getDatabase();
    const rows = db
      .query<ArtistRow, []>(
        `SELECT id, name, album_count, cover_art, starred
         FROM library_artists
         WHERE hidden = 0 AND name != 'Various Artists' COLLATE NOCASE
         ORDER BY name COLLATE NOCASE ASC`,
      )
      .all();
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
    const allRows = db
      .query<AlbumRow, [string, string]>(
        `${ALBUM_SELECT} WHERE (artist_id = ? OR id IN (SELECT album_id FROM library_album_artists WHERE artist_id = ?)) AND hidden = 0
         ORDER BY year DESC NULLS LAST, name COLLATE NOCASE ASC`,
      )
      .all(id, id);
    const downloadingKeys = getDownloadingGroupKeys(
      db,
      await activeTransferKeys(options.slskdRef),
    );
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
    return c.json({ artist: rowToArtist(artistRow), albums, singlesAndEps });
  });

  // Paginated individual songs for one artist (the artist page's "Songs" tab —
  // lazy-loaded, sortable, starred-filterable). Separate from /artists/:id so the
  // potentially-large track list loads on demand, not with the album shell.
  app.get('/artists/:id/songs', (c) => {
    const id = c.req.param('id');
    const size = Math.min(Number(c.req.query('size') ?? 60), 200);
    const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);
    const sort = c.req.query('sort') ?? 'newest';
    const starredOnly = c.req.query('starred') === 'true';
    const db = getDatabase();
    const wheres = ['(s.artist_id = ? OR s.id IN (SELECT song_id FROM library_song_artists WHERE artist_id = ?))', 's.hidden = 0'];
    if (starredOnly) wheres.push('s.starred IS NOT NULL');
    const rows = db
      .query<SongRow, [string, string, number, number]>(
        `${SONG_SELECT} WHERE ${wheres.join(' AND ')}
         ORDER BY ${songOrderBy(sort)} LIMIT ? OFFSET ?`,
      )
      .all(id, id, size, offset);
    const songs = rows.map(rowToSong);
    attachSongArtists(db, songs);
    return c.json(songs);
  });

  app.get('/artists/:id/appears-on', (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const rows = db
      .query<AlbumRow, [string, string]>(
        `${ALBUM_SELECT} WHERE id IN (
           SELECT DISTINCT ls.album_id FROM library_songs ls
           JOIN library_albums la ON la.id = ls.album_id
           WHERE (ls.artist_id = ? OR ls.id IN (SELECT song_id FROM library_song_artists WHERE artist_id = ?))
             AND la.classification = 'compilation' AND la.hidden = 0
         ) ORDER BY year DESC NULLS LAST, name COLLATE NOCASE ASC`,
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
    const exclClause = excl.sql ? `AND ${excl.sql}` : '';
    const rows = db
      .query<AlbumRow, (string | number)[]>(
        `${ALBUM_SELECT} WHERE hidden = 0 AND ${SINGLE_EP_CLASSIFICATION_SQL} ${exclClause}
         ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...excl.params, size, offset);
    const singles = rows.map(rowToAlbum);
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

    const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
    const order = albumOrderBy(type);

    const rows = db
      .query<
        AlbumRow,
        (string | number)[]
      >(`${ALBUM_SELECT} ${whereClause} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, size, offset);
    const albums = rows.map(rowToAlbum);
    return c.json(albums);
  });

  app.get('/compilations', async (c) => {
    const type = c.req.query('type') ?? 'newest';
    const size = Math.min(Number(c.req.query('size') ?? 20), 500);
    const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);
    const db = getDatabase();
    const order = albumOrderBy(type);
    const rows = db
      .query<AlbumRow, [number, number]>(
        `${ALBUM_SELECT} WHERE hidden = 0 AND classification = 'compilation'
         ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(size, offset);
    return c.json(rows.map(rowToAlbum));
  });

  app.get('/albums/:id', (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const albumRow = db.query<AlbumRow, [string]>(`${ALBUM_SELECT} WHERE id = ?`).get(id);
    if (!albumRow) {
      return c.json({ error: 'Album not found' }, 404);
    }
    const songRows = db
      .query<SongRow, [string]>(
        `${SONG_SELECT} WHERE s.album_id = ? AND s.hidden = 0
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
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);

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
      .query<
        { id: string; path: string; artist_id: string | null },
        [string]
      >('SELECT id, path, artist_id FROM library_songs WHERE album_id = ?')
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
    return c.json({ ok: failed.length === 0, deletedCount, failedCount: failed.length, failed });
  });

  // GET /api/library/untracked  (admin)
  // Completed downloads with no relative_path — files that predate the library
  // organizer and are otherwise invisible to playlist/deletion logic. Run the
  // backfill-untracked script to resolve the ones still on disk.
  app.get('/untracked', (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
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
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
    if (!curator) return c.json({ error: 'Curator not available' }, 503);
    const ok = curator.setManualOverride(c.req.param('id'), { hidden: true });
    return c.json({ ok });
  });

  app.post('/albums/:id/unhide', (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
    if (!curator) return c.json({ error: 'Curator not available' }, 503);
    const ok = curator.setManualOverride(c.req.param('id'), { hidden: false });
    return c.json({ ok });
  });

  app.post('/albums/:id/reclassify', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
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
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
    if (!curator) return c.json({ error: 'Curator not available' }, 503);
    const ok = curator.clearManualOverride(c.req.param('id'));
    return c.json({ ok });
  });

  // Re-fetch better cover/year/release-type for one album from Lidarr and
  // overwrite what's stored (the "fix a wrong/poor thumbnail" action). Admin
  // only; 503 when Lidarr is unconfigured, 404 when the album/match is absent.
  app.post('/albums/:id/optimize-metadata', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
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
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
    if (!lidarr) return c.json({ error: 'Lidarr not configured' }, 503);
    const res = await searchCandidates(getDatabase(), lidarr, c.req.param('id'), c.req.query('q'));
    if (!res) return c.json({ error: 'Album not found' }, 404);
    return c.json(res);
  });

  // Apply a confirmed correction (from a candidate or free-text). Persists an
  // override the scanner honors and re-buckets the canonical rows immediately.
  // Admin only. Does NOT require Lidarr (free-text fallback works offline).
  app.post('/albums/:id/metadata', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
    const body = await c.req.json<ApplyMetadataRequest>().catch(() => ({}) as ApplyMetadataRequest);
    if (!body.artist?.trim() && !body.album?.trim() && body.year == null && !body.coverUrl && !body.releaseType) {
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
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
    const id = c.req.param('id');
    const db = getDatabase();
    const album = db
      .query<{ id: string }, [string]>('SELECT id FROM library_albums WHERE id = ?')
      .get(id);
    if (!album) return c.json({ error: 'Album not found' }, 404);

    const current: AlbumCoverCandidate = { source: 'current', url: `/api/cover/${id}`, label: 'Current' };

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
      const distinct = await selectDistinctEmbeddedCovers(sources, (p) => extractEmbeddedPicture(p));
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
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
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
      return c.json({ ok: true });
    }

    return c.json({ error: 'Provide coverUrl or songId' }, 400);
  });

  // ── Artist image override (admin) ──────────────────────────────────────────
  // Give an artist a proper portrait — uploaded, or copied from one of the
  // artist's album covers — overriding the auto (Lidarr/Spotify) artwork and the
  // neutral placeholder. Stored as bytes keyed on the artist id and flagged
  // manual_override=1 so the enrichment task leaves the choice alone.
  const MAX_ARTIST_IMAGE_BYTES = 8 * 1024 * 1024;

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
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
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
    if (file.size > MAX_ARTIST_IMAGE_BYTES) {
      return c.json({ error: 'Image too large (max 8 MB)' }, 413);
    }
    const data = new Uint8Array(await file.arrayBuffer());
    if (data.length === 0) return c.json({ error: 'Empty image' }, 400);

    commitArtistImage(db, id, data, contentType);
    return c.json({ ok: true });
  });

  // Copy one of the artist's album covers into the portrait slot. Admin only.
  app.post('/artists/:id/image/from-album', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
    if (!dataDir) return c.json({ error: 'Data directory not configured' }, 503);
    const id = c.req.param('id');
    const db = getDatabase();
    if (!findArtist(db, id)) return c.json({ error: 'Artist not found' }, 404);

    const body = await c.req.json<{ albumId?: string }>().catch(() => ({}) as { albumId?: string });
    const albumId = body.albumId?.trim();
    if (!albumId) return c.json({ error: 'Provide albumId' }, 400);
    const album = db
      .query<
        { id: string },
        [string, string]
      >('SELECT id FROM library_albums WHERE id = ? AND artist_id = ?')
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
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
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

  app.post('/sync', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
    if (!runSync) return c.json({ error: 'Sync not available' }, 503);
    await runSync();
    return c.json({ ok: true });
  });

  // --- Songs --------------------------------------------------------------------
  app.get('/songs/:id', (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const row = db.query<SongRow, [string]>(`${SONG_SELECT} WHERE s.id = ?`).get(id);
    if (row) {
      const song = rowToSong(row);
      attachSongArtists(db, [song]);
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
      bpm = await analyzeBpm(abs);
      source = 'analyzed';
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

  // Apply a genre to a song (admin): writes the tag and updates library_songs +
  // library_genres counts so search/grouping reflect it immediately.
  app.post('/songs/:id/genre', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
    const id = c.req.param('id');
    const body = await c.req.json<{ genre?: string }>().catch(() => ({}) as { genre?: string });
    const genre = (body.genre ?? '').trim();
    if (!genre) return c.json({ error: 'genre is required' }, 400);

    const db = getDatabase();
    const song = db
      .query<{ path: string; genre: string | null }, [string]>(
        `SELECT path, genre FROM library_songs WHERE id = ?`,
      )
      .get(id);
    if (!song) return c.json({ error: 'Song not found' }, 404);

    if (musicDir) {
      const abs = resolveSongPath(expandDir(musicDir), song.path);
      if (isUnderMusicDir(expandDir(musicDir), abs) && existsSync(abs)) {
        await writeAudioTags(abs, { genre }).catch(() => false);
      }
    }
    db.run('UPDATE library_songs SET genre = ? WHERE id = ?', [genre, id]);
    return c.json({ ok: true, genre });
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
    for (const plugin of pluginRegistry.getEnabledWithCapability('lyrics')) {
      const result = await plugin.lyrics?.fetchLyrics(query).catch(() => null);
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
    return c.json(null);
  });

  // Save user-edited lyrics (admin): marks the row customized so a re-fetch won't
  // clobber it, clears the synced LRC (the edited body no longer matches its
  // timing), and writes the plain text back to the file tag.
  app.put('/songs/:id/lyrics', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
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
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
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
      .query<SongRow, [string]>(`${SONG_SELECT} WHERE s.artist_id = ? AND s.hidden = 0`)
      .all(source.artist_id);
    for (const row of artistSongs) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        candidateRows.push(row);
      }
    }

    if (source.genre) {
      const genreRows = db
        .query<SongRow, [string, string]>(
          `${SONG_SELECT} WHERE s.genre = ? AND s.artist_id != ? AND s.hidden = 0
           ORDER BY RANDOM() LIMIT 200`,
        )
        .all(source.genre, source.artist_id);
      for (const row of genreRows) {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          candidateRows.push(row);
        }
      }
    }

    const candidates = candidateRows.map((r) => ({
      ...songRowFeatures(r),
      _row: r,
    }));

    // Use a higher artist cap for "similar" than for radio — same-artist results
    // are expected here.
    const ranked = rankCandidates(seed, candidates, {
      count: size,
      maxPerArtist: 5,
      weights: { ...DEFAULT_WEIGHTS, artistPenalty: -3 },
    });

    const results = ranked.map((e) =>
      rowToSong((e.song as (typeof candidates)[number])._row),
    );

    return c.json(results);
  });

  app.get('/genres', (c) => {
    const db = getDatabase();
    const rows = db
      .query<
        { name: string; song_count: number; album_count: number },
        []
      >(`SELECT name, song_count, album_count FROM library_genres ORDER BY song_count DESC`)
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
        `${SONG_SELECT} WHERE s.genre = ? AND s.hidden = 0
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
         WHERE s.hidden = 0 AND (alb.hidden IS NULL OR alb.hidden = 0)
         ORDER BY RANDOM() LIMIT ?`,
      )
      .all(size);
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
         WHERE s.hidden = 0 AND (a.hidden IS NULL OR a.hidden = 0)
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
            return { ok: true };
          }
          return { ok: false, error: 'Song file not found on disk', status: 404 };
        }
      }
    }

    if (deletedPath) {
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
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);

    const result = await deleteOne(c.req.param('id'));
    if (!result.ok) {
      return c.json({ error: result.error }, (result.status ?? 500) as 400 | 404 | 500);
    }

    if (runSync) void runSync();

    return c.json({ ok: true });
  });

  app.post('/songs/bulk-delete', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);

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
        | PromiseFulfilledResult<{ ok: false; error: string; status: number }>
        | undefined;
      const status = firstError?.value.status ?? 500;
      return c.json(
        { error: firstError?.value.error ?? 'Failed to delete any songs' },
        status as 400 | 404 | 500,
      );
    }

    if (runSync) void runSync();

    return c.json({ ok: true, deletedCount: ids.length - failed.length });
  });

  // Duplicate detection — now reads entirely from canonical DB.
  app.get('/duplicates', (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);

    const db = getDatabase();
    const rows = db
      .query<
        SongRow,
        []
      >(`${SONG_SELECT} WHERE s.hidden = 0 AND (a.hidden IS NULL OR a.hidden = 0)`)
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
