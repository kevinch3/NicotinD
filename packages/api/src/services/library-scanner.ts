import { createHash } from 'node:crypto';
import { join, relative, sep, extname } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { createLogger } from '@nicotind/core';
import type { Database } from 'bun:sqlite';
import { albumGroupKey, normalizeForGrouping } from './album-grouping.js';
import { inferFolderAlbum, inferMetadataFromPath, hasUsableValue } from './path-inference.js';
import { getMusicMetadata } from './music-metadata-loader.js';

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
}

export interface SongRow {
  id: string;
  albumId: string;
  title: string;
  artist: string;
  artistId: string;
  track: number | null;
  disc: number | null;
  duration: number;
  year: number | null;
  genre: string | null;
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
  return sha1(`artist:${normalizeForGrouping(artist)}`);
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
 * Resolve final artist/album/title for a track, falling back to path inference
 * when ID3 tags are missing (common with Soulseek peers). Mirrors the
 * organizer's tag-derivation precedence so the scanner and organizer agree.
 */
function resolveTags(t: ScannedTrack): { artist: string; album: string; title: string } {
  const dir = t.relPath.split(/[\\/]+/).slice(0, -1).join('/');
  const inferred = inferMetadataFromPath(t.relPath, dir);

  const artist =
    (hasUsableValue(t.albumArtist) && t.albumArtist) ||
    (hasUsableValue(t.artist) && t.artist) ||
    (hasUsableValue(inferred.artist) ? inferred.artist : undefined) ||
    UNKNOWN_ARTIST;

  const album =
    (hasUsableValue(t.album) && t.album) ||
    inferFolderAlbum(dir, artist) ||
    (hasUsableValue(inferred.album) ? inferred.album : undefined) ||
    UNKNOWN_ALBUM;

  const title =
    (hasUsableValue(t.title) && t.title) ||
    (hasUsableValue(inferred.title) ? inferred.title : undefined) ||
    t.relPath.split(/[\\/]+/).pop()?.replace(/\.[^/.]+$/, '') ||
    'Unknown';

  return { artist, album, title };
}

/**
 * Pure aggregation: turn a flat list of scanned tracks into canonical album /
 * song / artist / genre rows. No IO — directly unit-testable.
 */
export function buildLibrary(tracks: ScannedTrack[]): BuiltLibrary {
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
    const { artist, album, title } = resolveTags(t);
    const aId = artistIdFor(artist);
    const albId = albumIdFor(artist, album);
    const id = songId(t.relPath);
    const created = new Date(t.mtimeMs).toISOString();

    songs.push({
      id,
      albumId: albId,
      title,
      artist,
      artistId: aId,
      track: t.track ?? null,
      disc: t.disc ?? null,
      duration: t.duration,
      year: t.year ?? null,
      genre: t.genre ?? null,
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
      if (t.year != null) acc.years.push(t.year);
      if (t.genre) acc.genres.push(t.genre);
      if (t.mtimeMs > acc.createdMs) acc.createdMs = t.mtimeMs;
    } else {
      albumAcc.set(albId, {
        id: albId,
        artist,
        artistId: aId,
        names: [album],
        songCount: 1,
        duration: t.duration,
        years: t.year != null ? [t.year] : [],
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
  const artistAcc = new Map<string, { id: string; name: string; albums: Set<string>; coverArt: string | null }>();
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
    const built = buildLibrary(tracks);
    const result = this.persist(built, startedAt, true);
    log.info({ ...result }, 'Full scan complete');
    return result;
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
    const built = buildLibrary(tracks);
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
        id, album_id, title, artist, artist_id, track, disc, duration,
        year, genre, cover_art, path, size, bit_rate, suffix, content_type,
        created, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        album_id = excluded.album_id,
        title = excluded.title,
        artist = excluded.artist,
        artist_id = excluded.artist_id,
        track = excluded.track,
        disc = excluded.disc,
        duration = excluded.duration,
        year = excluded.year,
        genre = excluded.genre,
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
          s.track,
          s.disc,
          s.duration,
          s.year,
          s.genre,
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
