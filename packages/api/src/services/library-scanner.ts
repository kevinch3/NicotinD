import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, relative, sep, extname } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { createLogger } from '@nicotind/core';
import type { Database } from 'bun:sqlite';
import { albumGroupKey, normalizeArtistForGrouping } from './album-grouping.js';
import { jobCanonicalTracklists } from './acquisition-job-store.js';
import { isVariousArtists } from './compilation-tagger.js';
import { inferFolderAlbum, inferMetadataFromPath, hasUsableValue } from './path-inference.js';
import { getMusicMetadata } from './music-metadata-loader.js';
import { featureTagsFromNative } from './audio-tags.js';
import { selectAlbumTracks } from './library-track-select.js';
import { loadOverrides, type MetadataOverrideValue } from './metadata-override-store.js';
import { splitArtists, isAtomicArtist, type ArtistCredit } from './artist-split.js';
import {
  loadSplitAuthority,
  emptyAuthority,
  type SplitAuthority,
} from './artist-identity-store.js';
import { pruneOrphanArtist } from './library-aggregates.js';
import { partitionByCache, loadScanCache, saveScanCache, type FileStat } from './scan-cache.js';
import {
  splitGenres,
  buildKnownFromRaw,
  genreKey,
  loadGenreContext,
  emptyGenreContext,
  type GenreContext,
} from './genre-split.js';

const log = createLogger('library-scanner');

/**
 * How many files to tag-parse in parallel. Tag reads are IO + CPU bound; a pool
 * bounded to the core count keeps a large cold scan busy without starving the
 * event loop or opening thousands of file handles at once.
 */
const TAG_READ_CONCURRENCY = Math.max(2, Math.min(8, cpus().length || 4));

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving input order
 * in the returned results. Pure/generic — unit-testable without the scanner.
 */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

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
  /**
   * Raw genre tag value(s). New parses store the FULL frame array; rows cached
   * before the multi-genre migration hold the old single string — both shapes
   * are valid splitGenres input, so stale cache rows still scan correctly.
   */
  genre?: string | string[];
  bpm?: number;
  key?: string;
  energy?: number;
  loudness?: number;
  danceability?: number;
  valence?: number;
  acousticness?: number;
  instrumental?: number;
  mood?: string;
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
  energy: number | null;
  loudness: number | null;
  danceability: number | null;
  valence: number | null;
  acousticness: number | null;
  instrumental: number | null;
  mood: string | null;
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
  /** True when the name is a compound the splitter resolves into >1 primary credit. */
  splitCompound: boolean;
}

export interface GenreRow {
  name: string;
  songCount: number;
  albumCount: number;
}

export interface ArtistLink {
  parentId: string;
  artistId: string;
  role: 'primary' | 'featuring';
  position: number;
}

export interface SongGenreLink {
  songId: string;
  genre: string;
  position: number;
}

export interface BuiltLibrary {
  songs: SongRow[];
  albums: AlbumRow[];
  artists: ArtistRow[];
  genres: GenreRow[];
  songArtists: ArtistLink[];
  albumArtists: ArtistLink[];
  songGenres: SongGenreLink[];
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
): {
  albumArtist: string;
  trackArtist: string;
  album: string;
  title: string;
  year: number | undefined;
} {
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
  authority: SplitAuthority = emptyAuthority(),
  genreCtx: GenreContext = emptyGenreContext(),
): BuiltLibrary {
  tracks = selectLibraryTracks(tracks, canonicalByAlbum, overrides);

  // Genre context: the caller's loaded vocabulary/aliases (db-settled display
  // casing wins) merged over the in-batch vocabulary, so the `/` rule and
  // casing normalization work on a fresh db and on incremental batches alike.
  const gctx: GenreContext = {
    aliases: genreCtx.aliases,
    known: new Map([...buildKnownFromRaw(tracks.map((t) => t.genre)), ...genreCtx.known]),
  };

  // Pass 1: assemble the split authority. A compound like "Bob Marley, Peter Tosh" is
  // split into individual artists ONLY when every part is confirmed; otherwise it is
  // kept whole (never mangle a band name). Confirmations come from (a) the caller's
  // DB-loaded authority (whole-library atomic names + Lidarr/MB decisions) and (b) any
  // *atomic* artist string in this batch — a compound never confirms itself. This is
  // the fix for the old self-defeating guard that added the compound strings verbatim
  // to the known set, so nothing ever split.
  // MBID-derived alias map: a spelling variant is rewritten to its canonical spelling
  // BEFORE any id is minted, so "Snoop Dog" and "Snoop Dogg" collapse into one entity
  // (artistIdFor is a pure string hash and would otherwise mint two). See
  // deriveMbidAliases — aliases exist only on MBID equality, never fuzzy matching.
  const aliasFix = (name: string): string =>
    authority.aliases.get(normalizeArtistForGrouping(name)) ?? name;
  // Split, then canonicalize each credit's spelling too (a member can be a variant).
  const splitCredits = (raw: string): ArtistCredit[] =>
    splitArtists(raw, known).map((c) => ({ ...c, name: aliasFix(c.name) }));

  const confirmedArtists = new Set<string>(authority.confirmedArtists);
  const canonicalWhole = authority.canonicalWhole;
  // Every alias pair is a confirmed real artist by construction (MBID-matched), so a
  // compound part written in a variant spelling still passes the split gate.
  for (const [aliasNorm, canonical] of authority.aliases) {
    confirmedArtists.add(aliasNorm);
    confirmedArtists.add(normalizeArtistForGrouping(canonical));
  }
  for (const t of tracks) {
    const { albumArtist, trackArtist } = resolveTags(t, overrides);
    if (isAtomicArtist(albumArtist))
      confirmedArtists.add(normalizeArtistForGrouping(aliasFix(albumArtist)));
    if (isAtomicArtist(trackArtist))
      confirmedArtists.add(normalizeArtistForGrouping(aliasFix(trackArtist)));
  }
  const known = { confirmedArtists, canonicalWhole };

  // Pass 2: build songs, albums, artists, and artist-link join rows.
  const songs: SongRow[] = [];
  const songArtistLinks: ArtistLink[] = [];
  const albumArtistLinks: ArtistLink[] = [];
  const songGenreLinks: SongGenreLink[] = [];
  const genreAcc = new Map<string, { display: string; songs: number; albums: Set<string> }>();
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
      splitCredits: ArtistCredit[];
    }
  >();

  for (const t of tracks) {
    const { album, title, year, ...rawArtists } = resolveTags(t, overrides);
    const albumArtist = aliasFix(rawArtists.albumArtist);
    const trackArtist = aliasFix(rawArtists.trackArtist);
    const albumArtistId = artistIdFor(albumArtist);
    const trackArtistId = artistIdFor(trackArtist);
    const albId = albumIdFor(albumArtist, album);
    const id = songId(t.relPath);
    const created = new Date(t.mtimeMs).toISOString();
    const genres = splitGenres(t.genre, gctx);
    for (let i = 0; i < genres.length; i++) {
      songGenreLinks.push({ songId: id, genre: genres[i]!, position: i });
      const key = genreKey(genres[i]!);
      const g = genreAcc.get(key) ?? { display: genres[i]!, songs: 0, albums: new Set<string>() };
      g.songs += 1;
      g.albums.add(albId);
      genreAcc.set(key, g);
    }

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
      genre: genres[0] ?? null,
      bpm: t.bpm ?? null,
      key: t.key ?? null,
      energy: t.energy ?? null,
      loudness: t.loudness ?? null,
      danceability: t.danceability ?? null,
      valence: t.valence ?? null,
      acousticness: t.acousticness ?? null,
      instrumental: t.instrumental ?? null,
      mood: t.mood ?? null,
      coverArt: id,
      path: t.relPath,
      size: t.size,
      bitRate: t.bitRate,
      suffix: t.suffix,
      contentType: t.contentType,
      created,
    });

    const trackCredits = splitCredits(trackArtist);
    for (let i = 0; i < trackCredits.length; i++) {
      songArtistLinks.push({
        parentId: id,
        artistId: artistIdFor(trackCredits[i].name),
        role: trackCredits[i].role,
        position: i,
      });
    }

    const acc = albumAcc.get(albId);
    if (acc) {
      acc.names.push(album);
      acc.songCount += 1;
      acc.duration += t.duration;
      if (year != null) acc.years.push(year);
      acc.genres.push(...genres);
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
        genres: [...genres],
        createdMs: t.mtimeMs,
        coverArt: albId,
        splitCredits: splitCredits(albumArtist),
      });
    }
  }

  const albums: AlbumRow[] = [];
  const artistAcc = new Map<
    string,
    { id: string; name: string; albums: Set<string>; coverArt: string | null }
  >();

  function ensureArtist(artistId: string, name: string, albumId?: string) {
    const ar = artistAcc.get(artistId);
    if (ar) {
      if (albumId) ar.albums.add(albumId);
    } else {
      artistAcc.set(artistId, {
        id: artistId,
        name,
        albums: albumId ? new Set([albumId]) : new Set(),
        coverArt: artistId,
      });
    }
  }

  for (const a of albumAcc.values()) {
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

    // Primary album artist (backward-compat single column)
    ensureArtist(a.artistId, a.artist, a.id);

    // Multi-artist join rows for this album
    for (let i = 0; i < a.splitCredits.length; i++) {
      const credit = a.splitCredits[i];
      const creditId = artistIdFor(credit.name);
      albumArtistLinks.push({
        parentId: a.id,
        artistId: creditId,
        role: credit.role,
        position: i,
      });
      ensureArtist(creditId, credit.name, a.id);
    }
  }

  // Ensure all song-level split artists have rows too
  for (const link of songArtistLinks) {
    if (!artistAcc.has(link.artistId)) {
      // Find the name from the credits — look up via songs
      const song = songs.find((s) => s.id === link.parentId);
      if (song) {
        const credits = splitCredits(song.artist);
        const credit = credits.find((c) => artistIdFor(c.name) === link.artistId);
        if (credit) ensureArtist(link.artistId, credit.name);
      }
    }
  }

  const artists: ArtistRow[] = [...artistAcc.values()].map((a) => ({
    id: a.id,
    name: a.name,
    albumCount: a.albums.size,
    coverArt: a.coverArt,
    // A compound that splits keeps its row (songs/albums key its id) but is
    // flagged so the grid shows only the member artists as tiles.
    splitCompound: splitCredits(a.name).filter((c) => c.role === 'primary').length > 1,
  }));

  // Genre aggregate over the FULL set (a song counts under every genre it
  // has), accumulated in the track loop above.
  const genres: GenreRow[] = [...genreAcc.values()].map((g) => ({
    name: g.display,
    songCount: g.songs,
    albumCount: g.albums.size,
  }));

  return {
    songs,
    albums,
    artists,
    genres,
    songArtists: songArtistLinks,
    albumArtists: albumArtistLinks,
    songGenres: songGenreLinks,
  };
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
    const built = buildLibrary(
      tracks,
      this.canonicalByAlbum(),
      loadOverrides(this.db),
      loadSplitAuthority(this.db),
      loadGenreContext(this.db),
    );
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
    // `album_jobs` UNION the unified `acquisition_jobs` (also carries canonical
    // tracklists for track-search grabs) via the shared job-store helper — it
    // parses the JSON and degrades to [] when the tables are absent.
    for (const { artistName, albumTitle, canonicalTracks } of jobCanonicalTracklists(this.db)) {
      const id = albumIdFor(artistName, albumTitle);
      const prev = map.get(id);
      if (!prev || canonicalTracks.length > prev.length) map.set(id, canonicalTracks);
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
    const built = buildLibrary(
      tracks,
      this.canonicalByAlbum(),
      loadOverrides(this.db),
      loadSplitAuthority(this.db),
      loadGenreContext(this.db),
    );
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

  /**
   * Resolve a flat list of files into scanned tracks. Files whose size + mtime
   * match the scan cache reuse their stored raw tags (no parseFile); the rest
   * are tag-parsed with bounded concurrency. Order is preserved (walk order) so
   * downstream aggregation is deterministic. Newly parsed tracks are written
   * back to the cache so the next scan skips them.
   */
  private async readTracks(absPaths: string[]): Promise<ScannedTrack[]> {
    const files: FileStat[] = [];
    for (const abs of absPaths) {
      const f = await this.statFile(abs);
      if (f) files.push(f);
    }

    const { hits, misses } = partitionByCache(files, loadScanCache(this.db));
    const parsed = await mapPool(misses, TAG_READ_CONCURRENCY, (f) => this.parseTrack(f));
    if (parsed.length > 0) saveScanCache(this.db, parsed);

    // Re-emit in walk order (hits + parsed merged by path) for deterministic aggregation.
    const byPath = new Map<string, ScannedTrack>();
    for (const t of hits) byPath.set(t.relPath, t);
    for (const t of parsed) byPath.set(t.relPath, t);
    return files.map((f) => byPath.get(f.relPath)).filter((t): t is ScannedTrack => t != null);
  }

  /** Stat one file and compute its normalized relative path, or null if outside the music dir. */
  private async statFile(abs: string): Promise<FileStat | null> {
    let relPath = relative(this.musicDir, abs);
    if (sep !== '/') relPath = relPath.split(sep).join('/');
    if (relPath.startsWith('..')) return null;
    try {
      const st = await stat(abs);
      return { abs, relPath, size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  }

  /** Parse tags for one already-stat'd file into a raw ScannedTrack (never re-stats). */
  private async parseTrack(f: FileStat): Promise<ScannedTrack> {
    const { abs, relPath } = f;
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
      size: f.size,
      mtimeMs: f.mtimeMs,
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
      // FULL frame array — buildLibrary's splitGenres derives the set/primary.
      genre: common?.genre?.length ? common.genre : undefined,
      bpm: typeof common?.bpm === 'number' && common.bpm > 0 ? Math.round(common.bpm) : undefined,
      key: typeof common?.key === 'string' && common.key.trim() ? common.key.trim() : undefined,
      // Perceptual features live in custom Vorbis/TXXX frames — parse them from
      // the native tag map so pre-tagged files are dense from the first scan.
      ...featureTagsFromNative(meta?.native, common?.mood),
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
        year, genre, bpm, key,
        energy, loudness, danceability, valence, acousticness, instrumental, mood,
        cover_art, path, size, bit_rate, suffix, content_type,
        created, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        -- Perceptual features: same durability contract — enrichment writes the
        -- DB immediately, the file-tag write may lag or fail; never let a
        -- tag-less rescan revert them.
        energy = COALESCE(excluded.energy, library_songs.energy),
        loudness = COALESCE(excluded.loudness, library_songs.loudness),
        danceability = COALESCE(excluded.danceability, library_songs.danceability),
        valence = COALESCE(excluded.valence, library_songs.valence),
        acousticness = COALESCE(excluded.acousticness, library_songs.acousticness),
        instrumental = COALESCE(excluded.instrumental, library_songs.instrumental),
        mood = COALESCE(excluded.mood, library_songs.mood),
        cover_art = excluded.cover_art,
        path = excluded.path,
        size = excluded.size,
        bit_rate = excluded.bit_rate,
        suffix = excluded.suffix,
        content_type = excluded.content_type,
        created = excluded.created,
        synced_at = excluded.synced_at
        -- landed_at is deliberately absent from BOTH the INSERT column list and
        -- this UPDATE SET: a fresh insert defaults it to NULL (quarantined until
        -- required processing steps finish) and a rescan of an already-landed song
        -- preserves its timestamp. The library-processing service (graduatePending)
        -- is the sole writer that sets a landed timestamp — do not add it here.
    `);
    const artistStmt = this.db.prepare(`
      INSERT INTO library_artists (id, name, album_count, cover_art, split_compound, synced_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        album_count = excluded.album_count,
        cover_art = excluded.cover_art,
        split_compound = excluded.split_compound,
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
    const songArtistStmt = this.db.prepare(`
      INSERT INTO library_song_artists (song_id, artist_id, role, position)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(song_id, artist_id, role) DO UPDATE SET
        position = excluded.position
    `);
    const albumArtistStmt = this.db.prepare(`
      INSERT INTO library_album_artists (album_id, artist_id, role, position)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(album_id, artist_id, role) DO UPDATE SET
        position = excluded.position
    `);
    const songGenreDeleteStmt = this.db.prepare(
      `DELETE FROM library_song_genres WHERE song_id = ?`,
    );
    const songGenreStmt = this.db.prepare(`
      INSERT INTO library_song_genres (song_id, genre, position)
      VALUES (?, ?, ?)
      ON CONFLICT(song_id, genre) DO UPDATE SET
        position = excluded.position
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
          s.energy,
          s.loudness,
          s.danceability,
          s.valence,
          s.acousticness,
          s.instrumental,
          s.mood,
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
        artistStmt.run(a.id, a.name, a.albumCount, a.coverArt, a.splitCompound ? 1 : 0, syncedAt);
      }
      for (const g of built.genres) {
        genreStmt.run(g.name, g.songCount, g.albumCount, syncedAt);
      }
      for (const link of built.songArtists) {
        songArtistStmt.run(link.parentId, link.artistId, link.role, link.position);
      }
      for (const link of built.albumArtists) {
        albumArtistStmt.run(link.parentId, link.artistId, link.role, link.position);
      }
      // Replace (not merge) each rescanned song's genre set so a changed tag
      // leaves no stale rows behind.
      for (const s of built.songs) {
        songGenreDeleteStmt.run(s.id);
      }
      for (const link of built.songGenres) {
        songGenreStmt.run(link.songId, link.genre, link.position);
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
      this.db.run(
        'DELETE FROM library_song_artists WHERE song_id NOT IN (SELECT id FROM library_songs)',
      );
      this.db.run(
        'DELETE FROM library_album_artists WHERE album_id NOT IN (SELECT id FROM library_albums)',
      );
      this.db.run(
        'DELETE FROM library_song_genres WHERE song_id NOT IN (SELECT id FROM library_songs)',
      );
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

  /**
   * Album-scoped reconcile: rescan the WHOLE of each affected album folder (so
   * every surviving on-disk file is re-indexed with a fresh synced_at), then
   * prune any library_songs row for those albums whose file no longer exists on
   * disk. This is the incremental analogue of scanFull's global prune — it kills
   * cross-wave orphan rows (files the organizer just deleted) without a full walk.
   */
  async reconcileAlbums(albumDirs: string[]): Promise<void> {
    const dirs = [...new Set(albumDirs)];
    if (dirs.length === 0) return;
    const abs: string[] = [];
    for (const d of dirs) abs.push(...(await this.walk(d)));
    const syncedAt = Date.now();
    const tracks = await this.readTracks(abs);
    if (tracks.length > 0) {
      const built = buildLibrary(
        tracks,
        this.canonicalByAlbum(),
        loadOverrides(this.db),
        loadSplitAuthority(this.db),
      );
      this.persist(built, syncedAt, false);
      this.pruneAlbumOrphans(built.albums.map((a) => a.id));
    }
    log.info({ dirs: dirs.length, files: abs.length }, 'Album-scoped reconcile complete');
  }

  /** Delete library_songs rows for the given albums whose file is gone from disk. */
  private pruneAlbumOrphans(albumIds: string[]): void {
    for (const albumId of [...new Set(albumIds)]) {
      const rows = this.db
        .query<{ id: string; path: string; artist_id: string | null }, [string]>(
          'SELECT id, path, artist_id FROM library_songs WHERE album_id = ?',
        )
        .all(albumId);
      let removed = 0;
      for (const r of rows) {
        if (r.path && existsSync(join(this.musicDir, r.path))) continue;
        this.db.run('DELETE FROM library_songs WHERE id = ?', [r.id]);
        this.db.run('DELETE FROM library_song_artists WHERE song_id = ?', [r.id]);
        this.db.run('DELETE FROM library_song_genres WHERE song_id = ?', [r.id]);
        removed++;
      }
      if (removed > 0) {
        // Recompute the album aggregate from its surviving songs.
        this.db.run(
          `UPDATE library_albums SET
             song_count = (SELECT COUNT(*) FROM library_songs WHERE album_id = ?),
             duration   = (SELECT COALESCE(SUM(duration),0) FROM library_songs WHERE album_id = ?)
           WHERE id = ?`,
          [albumId, albumId, albumId],
        );
        // Drop an album row that lost all songs, and prune a now-orphan artist.
        const count = this.db
          .query<{ n: number }, [string]>(
            'SELECT COUNT(*) AS n FROM library_songs WHERE album_id = ?',
          )
          .get(albumId)!.n;
        if (count === 0) {
          const artistRow = this.db
            .query<{ artist_id: string | null }, [string]>(
              'SELECT artist_id FROM library_albums WHERE id = ?',
            )
            .get(albumId);
          this.db.run('DELETE FROM library_albums WHERE id = ?', [albumId]);
          this.db.run('DELETE FROM library_album_artists WHERE album_id = ?', [albumId]);
          if (artistRow?.artist_id) pruneOrphanArtist(this.db, artistRow.artist_id);
        }
      }
    }
  }
}
