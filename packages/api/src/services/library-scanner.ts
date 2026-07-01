import { createHash } from 'node:crypto';
import { join, relative, sep, extname } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { createLogger } from '@nicotind/core';
import type { Database } from 'bun:sqlite';
import { albumGroupKey, normalizeArtistForGrouping } from './album-grouping.js';
import { isVariousArtists } from './compilation-tagger.js';
import { inferFolderAlbum, inferMetadataFromPath, hasUsableValue } from './path-inference.js';
import { getMusicMetadata } from './music-metadata-loader.js';
import { selectAlbumTracks } from './library-track-select.js';
import { loadOverrides, type MetadataOverrideValue } from './metadata-override-store.js';

const log = createLogger('library-scanner');

/** File extensions we treat as scannable audio. */
export const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.m4a',
  '.aac',
  '.ogg',
  '.opus',
  '.wav',
  '.wma',
  '.webm', // yt-dlp bestaudio output; contains opus audio
]);

const CONTENT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',
  wma: 'audio/x-ms-wma',
  webm: 'audio/webm',
};

/** Raw, IO-derived view of one audio file — the pure aggregation input. */
export interface ScannedTrack {
  relPath: string;
  size: number;
  mtimeMs: number;
  suffix: string;
  contentType: string;
  duration: number;
  bitRate: number;
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  track?: number;
  disc?: number;
  year?: number;
  genre?: string;
  bpm?: number;
  key?: string;
}

export interface SongRow {
  id: string;
  albumId: string;
  title: string;
  artist: string;
  artistId: string;
  albumArtist: string;
  albumArtistId: string;
  track: number | null;
  disc: number | null;
  duration: number;
  year: number | null;
  genre: string | null;
  bpm: number | null;
  key: string | null;
  coverArt: string;
  path: string;
  size: number;
  bitRate: number;
  suffix: string;
  contentType: string;
  created: string;
}

export interface AlbumRow {
  id: string;
  name: string;
  artist: string;
  artistId: string;
  coverArt: string;
  songCount: number;
  duration: number;
  year: number | null;
  genre: string | null;
  created: string;
}

export interface ArtistRow {
  id: string;
  name: string;
  albumCount: number;
  coverArt: string | null;
}

export interface GenreRow {
  name: string;
  songCount: number;
  albumCount: number;
}

export interface BuiltLibrary {
  songs: SongRow[];
  albums: AlbumRow[];
  artists: ArtistRow[];
  genres: GenreRow[];
}

const UNKNOWN_ARTIST = 'Unknown Artist';
const UNKNOWN_ALBUM = 'Unknown Album';

function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

/** Stable song id from its path — survives rescans so curation/playback persist. */
export function songId(relPath: string): string {
  return sha1(`song:${relPath}`);
}

/** Stable artist id — same normalized artist always maps to one id. */
export function artistIdFor(artist: string): string {
  return sha1(`artist:${normalizeArtistForGrouping(artist)}`);
}

/**
 * Stable album id from artist + title group key. Because the key strips
 * diacritics/punctuation/edition qualifiers (see album-grouping.ts), every
 * edition and punctuation-variant folder of one release collapses to a single
 * id at scan time — no post-hoc merge/reconciliation needed.
 */
export function albumIdFor(artist: string, album: string): string {
  return sha1(`album:${albumGroupKey(artist, album)}`);
}

function contentTypeFor(suffix: string): string {
  return CONTENT_TYPES[suffix] ?? 'application/octet-stream';
}

/**
 * True when a track is a loose single rather than part of a real album: it has
 * no usable album identity (`UNKNOWN_ALBUM`) or it sits in the organizer's
 * synthetic `<Artist>/Singles/` bucket. Such a track becomes its **own** single
 * release named after its title — so each loose track is one card (out of the
 * album grid) instead of all of an artist's loose tracks collapsing into one
 * hidden "Singles" bucket. Pure/exported for unit testing.
 */
export function isLooseSinglesBucket(dir: string, album: string): boolean {
  if (album === UNKNOWN_ALBUM) return true;
  const leaf = dir.split(/[\\/]+/).pop() ?? '';
  return leaf.trim().toLowerCase() === 'singles' || album.trim().toLowerCase() === 'singles';
}

/**
 * Resolve final artist/album/title for a track, falling back to path inference
 * when ID3 tags are missing (common with Soulseek peers). Returns both the
 * album-level artist (for grouping/ownership) and the track-level artist (for
 * display). On compilations the two differ: albumArtist = "Various Artists",
 * trackArtist = the actual performer.
 */
function resolveTags(
  t: ScannedTrack,
  overrides?: ReadonlyMap<string, MetadataOverrideValue>,
): { albumArtist: string; trackArtist: string; album: string; title: string; year: number | undefined } {
  const dir = t.relPath
    .split(/[\\/]+/)
    .slice(0, -1)
    .join('/');
  const inferred = inferMetadataFromPath(t.relPath, dir);

  // Album artist: used for album grouping and artist ownership.
  let albumArtist =
    (hasUsableValue(t.albumArtist) && t.albumArtist) ||
    (hasUsableValue(t.artist) && t.artist) ||
    (hasUsableValue(inferred.artist) ? inferred.artist : undefined) ||
    UNKNOWN_ARTIST;

  // Track artist: the actual performer on this track. For compilations where
  // albumArtist is "Various Artists", prefer the per-track artist tag.
  const albumArtistIsVA = hasUsableValue(t.albumArtist) && isVariousArtists(t.albumArtist!);
  let trackArtist: string;
  if (albumArtistIsVA && hasUsableValue(t.artist)) {
    trackArtist = t.artist!;
  } else {
    trackArtist = albumArtist;
  }

  const title =
    (hasUsableValue(t.title) && t.title) ||
    (hasUsableValue(inferred.title) ? inferred.title : undefined) ||
    t.relPath
      .split(/[\\/]+/)
      .pop()
      ?.replace(/\.[^/.]+$/, '') ||
    'Unknown';

  let album =
    (hasUsableValue(t.album) && t.album) ||
    inferFolderAlbum(dir, albumArtist) ||
    (hasUsableValue(inferred.album) ? inferred.album : undefined) ||
    UNKNOWN_ALBUM;

  // A loose single (no real album, or the synthetic Singles bucket) becomes its
  // own single release named after the track title. `albumIdFor(artist, title)`
  // gives each loose track a distinct album id, while format-dupes of the same
  // title still collapse via the shared normalized-title group key.
  if (isLooseSinglesBucket(dir, album)) {
    album = title;
  }

  let year = t.year ?? undefined;

  // User-confirmed correction (e.g. a mis-tagged "<Desconocido>" artist): look up
  // by the **raw** albumId derived from the on-disk tags above, then substitute
  // the corrected names/year so downstream artistId/albumId re-bucket. Stable
  // across rescans — tags never change, so the raw key is reproducible.
  const ov = overrides?.get(albumIdFor(albumArtist, album));
  if (ov) {
    if (ov.artist != null) {
      albumArtist = ov.artist;
      if (!albumArtistIsVA) trackArtist = ov.artist;
    }
    if (ov.album != null) album = ov.album;
    if (ov.year != null) year = ov.year;
  }

  return { albumArtist, trackArtist, album, title, year };
}

/**
 * Reduce a flat track list to a clean, consumable set: one best-quality file per
 * track per album. Groups by the same album id the scanner mints (so cross-folder
 * editions dedupe together), then defers to `selectAlbumTracks` — which keys to
 * the canonical Lidarr tracklist when `canonicalByAlbum` has one (dropping foreign
 * rips) and otherwise collapses format-duplicates by title. Pure.
 */
export function selectLibraryTracks(
  tracks: ScannedTrack[],
  canonicalByAlbum?: Map<string, string[]>,
  overrides?: ReadonlyMap<string, MetadataOverrideValue>,
): ScannedTrack[] {
  const byAlbum = new Map<
    string,
    Array<{ track: ScannedTrack; relPath: string; title: string; suffix: string; bitRate: number }>
  >();
  for (const t of tracks) {
    const { albumArtist, album, title } = resolveTags(t, overrides);
    const albId = albumIdFor(albumArtist, album);
    const arr = byAlbum.get(albId) ?? [];
    arr.push({ track: t, relPath: t.relPath, title, suffix: t.suffix, bitRate: t.bitRate });
    byAlbum.set(albId, arr);
  }
  const kept: ScannedTrack[] = [];
  for (const [albId, group] of byAlbum) {
    for (const sel of selectAlbumTracks(group, canonicalByAlbum?.get(albId))) {
      kept.push(sel.track);
    }
  }
  return kept;
}

/**
 * Pure aggregation: turn a flat list of scanned tracks into canonical album /
 * song / artist / genre rows. No IO — directly unit-testable. Tracks are first
 * passed through `selectLibraryTracks` so the built library is always a clean
 * one-best-file-per-track view (see that helper + `selectAlbumTracks`).
 */
export function buildLibrary(
  tracks: ScannedTrack[],
  canonicalByAlbum?: Map<string, string[]>,
  overrides?: ReadonlyMap<string, MetadataOverrideValue>,
): BuiltLibrary {
  tracks = selectLibraryTracks(tracks, canonicalByAlbum, overrides);
  const songs: SongRow[] = [];
  // album id -> accumulating state
  const albumAcc = new Map<
    string,
    {
      id: string;
      artist: string;
      artistId: string;
      names: string[];
      songCount: number;
      duration: number;
      years: number[];
      genres: string[];
      createdMs: number;
      coverArt: string;
    }
  >();

  for (const t of tracks) {
    const { albumArtist, trackArtist, album, title, year } = resolveTags(t, overrides);
    const albumArtistId = artistIdFor(albumArtist);
    const trackArtistId = artistIdFor(trackArtist);
    const albId = albumIdFor(albumArtist, album);
    const id = songId(t.relPath);
    const created = new Date(t.mtimeMs).toISOString();

    songs.push({
      id,
      albumId: albId,
      title,
      artist: trackArtist,
      artistId: trackArtistId,
      albumArtist,
      albumArtistId,
      track: t.track ?? null,
      disc: t.disc ?? null,
      duration: t.duration,
      year: year ?? null,
      genre: t.genre ?? null,
      bpm: t.bpm ?? null,
      key: t.key ?? null,
      coverArt: id,
      path: t.relPath,
      size: t.size,
      bitRate: t.bitRate,
      suffix: t.suffix,
      contentType: t.contentType,
      created,
    });

    const acc = albumAcc.get(albId);
    if (acc) {
      acc.names.push(album);
      acc.songCount += 1;
      acc.duration += t.duration;
      if (year != null) acc.years.push(year);
      if (t.genre) acc.genres.push(t.genre);
      if (t.mtimeMs > acc.createdMs) acc.createdMs = t.mtimeMs;
    } else {
      albumAcc.set(albId, {
        id: albId,
        artist: albumArtist,
        artistId: albumArtistId,
        names: [album],
        songCount: 1,
        duration: t.duration,
        years: year != null ? [year] : [],
        genres: t.genre ? [t.genre] : [],
        createdMs: t.mtimeMs,
        // Album cover id = the album id itself: the cover route checks
        // library_artwork (canonical Lidarr art) by this id first, then falls
        // back to a representative song's folder/embedded art via resolvePath.
        coverArt: albId,
      });
    }
  }

  const albums: AlbumRow[] = [];
  const artistAcc = new Map<
    string,
    { id: string; name: string; albums: Set<string>; coverArt: string | null }
  >();
  for (const a of albumAcc.values()) {
    // Display name = shortest member title so the base edition wins over a
    // longer "(Deluxe Edition)" sibling that shares the group key.
    const name = a.names.reduce((x, y) => (y.length < x.length ? y : x));
    albums.push({
      id: a.id,
      name,
      artist: a.artist,
      artistId: a.artistId,
      coverArt: a.coverArt,
      songCount: a.songCount,
      duration: a.duration,
      year: a.years.length ? Math.min(...a.years) : null,
      genre: a.genres[0] ?? null,
      created: new Date(a.createdMs).toISOString(),
    });

    const ar = artistAcc.get(a.artistId);
    if (ar) {
      ar.albums.add(a.id);
    } else {
      artistAcc.set(a.artistId, {
        id: a.artistId,
        name: a.artist,
        albums: new Set([a.id]),
        // Artist cover id = the artist id itself, so the cover route serves the
        // canonical Lidarr poster (audio files carry none); disk fallback finds
        // a representative song by artist_id.
        coverArt: a.artistId,
      });
    }
  }

  const artists: ArtistRow[] = [...artistAcc.values()].map((a) => ({
    id: a.id,
    name: a.name,
    albumCount: a.albums.size,
    coverArt: a.coverArt,
  }));

  const genreAcc = new Map<string, { songs: number; albums: Set<string> }>();
  for (const s of songs) {
    if (!s.genre) continue;
    const g = genreAcc.get(s.genre) ?? { songs: 0, albums: new Set<string>() };
    g.songs += 1;
    g.albums.add(s.albumId);
    genreAcc.set(s.genre, g);
  }
  const genres: GenreRow[] = [...genreAcc.entries()].map(([name, g]) => ({
    name,
    songCount: g.songs,
    albumCount: g.albums.size,
  }));

  return { songs, albums, artists, genres };
}

export interface ScanResult {
  durationMs: number;
  albums: number;
  songs: number;
  artists: number;
  genres: number;
  removedAlbums: number;
  removedSongs: number;
}

/**
 * Native library scanner — replaces NavidromeSyncer. Walks the music dir,
 * reads tags with music-metadata, and writes the canonical library_* tables
 * directly. Synchronous-from-the-caller's-view (no async external scanner), so
 * the whole class of Navidrome scan-timing races disappears.
 *
 * The UI reads only from these tables, so curation columns (hidden,
 * classification, manual_override, starred) are keyed on the stable id and
 * preserved across rescans.
 */
export class LibraryScanner {
  constructor(
    private musicDir: string,
    private db: Database,
  ) {}

  /** Full rescan: walk the whole music dir and reconcile the library tables. */
  async scanFull(): Promise<ScanResult> {
    const startedAt = Date.now();
    const files = await this.walk(this.musicDir);
    const tracks = await this.readTracks(files);
    const built = buildLibrary(tracks, this.canonicalByAlbum(), loadOverrides(this.db));
    const result = this.persist(built, startedAt, true);
    log.info({ ...result }, 'Full scan complete');
    return result;
  }

  /**
   * Map album id → canonical Lidarr track titles, drawn from recorded album jobs.
   * Lets the scanner present exactly the album Lidarr proposes: one best file per
   * canonical track, foreign/mislabeled rips excluded. Prefers the fullest list
   * when an album has multiple jobs.
   */
  private canonicalByAlbum(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    let rows: Array<{ artist_name: string; album_title: string; canonical_tracks_json: string }>;
    try {
      rows = this.db
        .query<{ artist_name: string; album_title: string; canonical_tracks_json: string }, []>(
          `SELECT artist_name, album_title, canonical_tracks_json FROM album_jobs
           WHERE artist_name IS NOT NULL AND album_title IS NOT NULL AND canonical_tracks_json IS NOT NULL`,
        )
        .all();
    } catch {
      return map; // album_jobs absent (e.g. slskd unconfigured) — no canonical data
    }
    for (const r of rows) {
      let titles: unknown;
      try {
        titles = JSON.parse(r.canonical_tracks_json);
      } catch {
        continue;
      }
      if (!Array.isArray(titles) || titles.length === 0) continue;
      const id = albumIdFor(r.artist_name, r.album_title);
      const prev = map.get(id);
      if (!prev || titles.length > prev.length) map.set(id, titles as string[]);
    }
    return map;
  }

  /**
   * Incremental scan of specific just-organized files (relative paths). Adds /
   * updates only those songs and recomputes the albums they touch. Does not
   * prune — used right after a download batch lands.
   */
  async scanPaths(relPaths: string[]): Promise<void> {
    const abs = relPaths.map((p) => join(this.musicDir, p));
    const tracks = await this.readTracks(abs);
    if (tracks.length === 0) return;
    const built = buildLibrary(tracks, this.canonicalByAlbum(), loadOverrides(this.db));
    this.persist(built, Date.now(), false);
    log.info({ files: tracks.length, albums: built.albums.length }, 'Incremental scan complete');
  }

  private async walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      log.warn({ err, dir }, 'walk: readdir failed');
      return out;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await this.walk(full)));
      } else if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
    return out;
  }

  private async readTracks(absPaths: string[]): Promise<ScannedTrack[]> {
    const out: ScannedTrack[] = [];
    for (const abs of absPaths) {
      const track = await this.readTrack(abs);
      if (track) out.push(track);
    }
    return out;
  }

  private async readTrack(abs: string): Promise<ScannedTrack | null> {
    let relPath = relative(this.musicDir, abs);
    if (sep !== '/') relPath = relPath.split(sep).join('/');
    if (relPath.startsWith('..')) return null;
    let st;
    try {
      st = await stat(abs);
    } catch {
      return null;
    }
    const suffix = extname(abs).slice(1).toLowerCase();
    const mm = await getMusicMetadata();
    let meta;
    try {
      meta = mm ? await mm.parseFile(abs, { duration: true, skipCovers: true }) : undefined;
    } catch (err) {
      log.debug({ err, abs }, 'readTrack: parseFile failed; indexing with path inference only');
      meta = undefined;
    }
    const common = meta?.common;
    const format = meta?.format;
    return {
      relPath,
      size: st.size,
      mtimeMs: st.mtimeMs,
      suffix,
      contentType: contentTypeFor(suffix),
      duration: format?.duration ? Math.round(format.duration) : 0,
      bitRate: format?.bitrate ? Math.round(format.bitrate / 1000) : 0,
      title: common?.title,
      artist: common?.artist,
      albumArtist: common?.albumartist,
      album: common?.album,
      track: common?.track?.no ?? undefined,
      disc: common?.disk?.no ?? undefined,
      year: common?.year ?? undefined,
      genre: common?.genre?.[0],
      bpm: typeof common?.bpm === 'number' && common.bpm > 0 ? Math.round(common.bpm) : undefined,
      key: typeof common?.key === 'string' && common.key.trim() ? common.key.trim() : undefined,
    };
  }

  /**
   * Write the built library to sqlite. On a full scan, prune rows whose paths
   * no longer exist. Curation columns are preserved by ON CONFLICT updates that
   * never touch hidden/classification/manual_override/starred.
   */
  persist(built: BuiltLibrary, syncedAt: number, prune: boolean): ScanResult {
    const albumStmt = this.db.prepare(`
      INSERT INTO library_albums (
        id, name, artist, artist_id, cover_art, song_count, duration,
        year, genre, created, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        artist = excluded.artist,
        artist_id = excluded.artist_id,
        cover_art = excluded.cover_art,
        song_count = excluded.song_count,
        duration = excluded.duration,
        year = excluded.year,
        genre = excluded.genre,
        created = excluded.created,
        synced_at = excluded.synced_at
    `);
    const songStmt = this.db.prepare(`
      INSERT INTO library_songs (
        id, album_id, title, artist, artist_id, album_artist, album_artist_id,
        track, disc, duration,
        year, genre, bpm, key, cover_art, path, size, bit_rate, suffix, content_type,
        created, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        album_id = excluded.album_id,
        title = excluded.title,
        artist = excluded.artist,
        artist_id = excluded.artist_id,
        album_artist = excluded.album_artist,
        album_artist_id = excluded.album_artist_id,
        track = excluded.track,
        disc = excluded.disc,
        duration = excluded.duration,
        year = excluded.year,
        -- Keep an enriched genre when a rescan reads no genre tag. Windowed/Lidarr
        -- genre fills write the DB immediately but the file-tag write can lag; a
        -- plain genre=excluded.genre would let the frequent full scans revert the
        -- enrichment before the tag lands. A tag that DOES carry a genre still
        -- overrides. (Same durability contract as bpm/key.)
        genre = COALESCE(excluded.genre, library_songs.genre),
        -- Keep an existing (e.g. analyzed) bpm when a rescan reads no tag value.
        bpm = COALESCE(excluded.bpm, library_songs.bpm),
        -- Likewise keep an analyzed key when a rescan reads no tag value.
        key = COALESCE(excluded.key, library_songs.key),
        cover_art = excluded.cover_art,
        path = excluded.path,
        size = excluded.size,
        bit_rate = excluded.bit_rate,
        suffix = excluded.suffix,
        content_type = excluded.content_type,
        created = excluded.created,
        synced_at = excluded.synced_at
    `);
    const artistStmt = this.db.prepare(`
      INSERT INTO library_artists (id, name, album_count, cover_art, synced_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        album_count = excluded.album_count,
        cover_art = excluded.cover_art,
        synced_at = excluded.synced_at
    `);
    const genreStmt = this.db.prepare(`
      INSERT INTO library_genres (name, song_count, album_count, synced_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        song_count = excluded.song_count,
        album_count = excluded.album_count,
        synced_at = excluded.synced_at
    `);

    this.db.transaction(() => {
      for (const a of built.albums) {
        albumStmt.run(
          a.id,
          a.name,
          a.artist,
          a.artistId,
          a.coverArt,
          a.songCount,
          a.duration,
          a.year,
          a.genre,
          a.created,
          syncedAt,
        );
      }
      for (const s of built.songs) {
        songStmt.run(
          s.id,
          s.albumId,
          s.title,
          s.artist,
          s.artistId,
          s.albumArtist,
          s.albumArtistId,
          s.track,
          s.disc,
          s.duration,
          s.year,
          s.genre,
          s.bpm,
          s.key,
          s.coverArt,
          s.path,
          s.size,
          s.bitRate,
          s.suffix,
          s.contentType,
          s.created,
          syncedAt,
        );
      }
      for (const a of built.artists) {
        artistStmt.run(a.id, a.name, a.albumCount, a.coverArt, syncedAt);
      }
      for (const g of built.genres) {
        genreStmt.run(g.name, g.songCount, g.albumCount, syncedAt);
      }
    })();

    let removedAlbums = 0;
    let removedSongs = 0;
    if (prune) {
      removedSongs = Number(
        this.db.run('DELETE FROM library_songs WHERE synced_at < ?', [syncedAt]).changes ?? 0,
      );
      removedAlbums = Number(
        this.db.run('DELETE FROM library_albums WHERE synced_at < ?', [syncedAt]).changes ?? 0,
      );
      this.db.run('DELETE FROM library_artists WHERE synced_at < ?', [syncedAt]);
      this.db.run('DELETE FROM library_genres WHERE synced_at < ?', [syncedAt]);
    } else {
      // Incremental: an album we just touched may have gained songs; recompute
      // its aggregate counts from all of its current songs so the card is right.
      for (const a of built.albums) {
        this.db.run(
          `UPDATE library_albums SET
             song_count = (SELECT COUNT(*) FROM library_songs WHERE album_id = ?),
             duration   = (SELECT COALESCE(SUM(duration),0) FROM library_songs WHERE album_id = ?)
           WHERE id = ?`,
          [a.id, a.id, a.id],
        );
      }
    }

    this.db.run(
      `INSERT INTO library_sync_state (key, value, updated_at)
       VALUES ('last_full_sync_at', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [String(syncedAt), syncedAt],
    );

    return {
      durationMs: Date.now() - syncedAt,
      albums: built.albums.length,
      songs: built.songs.length,
      artists: built.artists.length,
      genres: built.genres.length,
      removedAlbums,
      removedSongs,
    };
  }
}
