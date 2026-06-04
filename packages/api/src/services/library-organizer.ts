import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  appendFileSync,
  copyFileSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { cleanFolderName, createLogger, parseYearFromFolder } from '@nicotind/core';
import { classifyFolder, type Classification } from './compilation-tagger.js';
import { extractAlbumName, inferFolderAlbum, inferMetadataFromPath } from './path-inference.js';
import type { CompletedDownloadFile } from './path-inference.js';
import {
  readAudioTags,
  writeAudioTags,
  normalizeTagValue,
  AUDIO_EXTS,
  type AudioTags,
} from './audio-tags.js';
import {
  sanitizeSegment,
  trackNumberPrefix,
  stripAudioExt,
  stripTrackPrefix,
  isTrackNumberFragment,
  looksLikeFilenameTag,
  stripArtistLeadJunk,
  stripFeaturingSuffix,
} from './path-sanitize.js';
import { isAbsolute } from 'node:path';
import type { AcoustIdLookup } from './acoustid-lookup.js';
import { normalizeTitle } from './album-hunter.service.js';
import { dedupeFolder } from './album-dedupe.js';

const log = createLogger('library-organizer');

export interface LibraryOrganizerOptions {
  musicDir: string;
  /** Where slskd drops completed files. If absent, organizer reads files in-place from musicDir. */
  stagingDir?: string;
  /** When provided, files with no usable artist/title tags will be fingerprinted. */
  acoustid?: AcoustIdLookup;
  /** Append every move (`src → dst`) here, one per line. Lets the user revert manually. */
  moveLogPath?: string;
  /** Subfolder under musicDir where unsortable tracks land. Defaults to "Unsorted". */
  unsortedRoot?: string;
  /**
   * When true, an incoming MP3 is dropped (and its source removed) if a FLAC of
   * the same track already exists in the destination album folder. Prevents the
   * mixed MP3+FLAC duplicate albums the analysis flagged. Opt-in.
   */
  preferFlacSkipMp3?: boolean;
  /**
   * After placing a batch, remove redundant duplicate copies (`02 - Song (2)`,
   * mixed FLAC/MP3 of the same track) from each album folder it touched. On by
   * default — these are always-unwanted collisions that split Navidrome albums.
   */
  autoDedupe?: boolean;
  /**
   * Resolve a peer-side download directory to the canonical album it was hunted
   * as. When a group's directory matches a recorded album job, the destination
   * folder is named after the Lidarr canonical album (not the peer's edition
   * tag), so every edition/re-hunt of an album consolidates into one
   * `<Artist>/<canonical-album>` dir instead of spawning edition-variant siblings.
   */
  jobLookup?: (peerDirectory: string) => { artist?: string | null; album?: string | null } | null;
}

export interface OrganizeResult {
  moved: number;
  skipped: number;
  unsorted: number;
  failed: number;
  /** Basenames (lowercased) of duplicate files auto-dedupe removed this batch. */
  dedupedBasenames: string[];
}

/** A file already located on disk, plus its read tags. */
interface ResolvedFile {
  /** Source absolute path (where the file currently is). */
  srcPath: string;
  /** The original peer-side folder name (for classifier heuristics). */
  peerDirectory: string;
  /** Filename as reported by slskd / inferred from disk. */
  filename: string;
  tags: AudioTags;
  /** Original completion record — we mutate its relativePath after placing. */
  source?: CompletedDownloadFile;
}

export class LibraryOrganizer {
  private musicDir: string;
  private stagingDir: string | undefined;
  private moveLogPath: string | undefined;
  private unsortedRoot: string;
  private acoustid: AcoustIdLookup | undefined;
  private preferFlacSkipMp3: boolean;
  private autoDedupe: boolean;
  private jobLookup?: (
    peerDirectory: string,
  ) => { artist?: string | null; album?: string | null } | null;
  /** Real <Artist>/<Album> dirs written during the current batch (for dedupe). */
  private touchedAlbumDirs = new Set<string>();

  constructor(opts: LibraryOrganizerOptions) {
    this.musicDir = expandHome(opts.musicDir);
    this.stagingDir = opts.stagingDir ? expandHome(opts.stagingDir) : undefined;
    this.acoustid = opts.acoustid;
    this.moveLogPath = opts.moveLogPath;
    this.preferFlacSkipMp3 = opts.preferFlacSkipMp3 ?? false;
    this.autoDedupe = opts.autoDedupe ?? true;
    this.jobLookup = opts.jobLookup;
    // unsortedRoot may be relative (resolved under musicDir) or absolute (e.g.
    // <dataDir>/unsorted so Navidrome doesn't index the bucket).
    const rawUnsorted = opts.unsortedRoot ?? 'Unsorted';
    this.unsortedRoot = isAbsolute(rawUnsorted) ? expandHome(rawUnsorted) : rawUnsorted;
    mkdirSync(this.musicDir, { recursive: true });
  }

  /**
   * Organize a batch of completed download files. Groups by peer-side
   * directory, then per-directory: locate files on disk → read tags →
   * classify → move into `<musicDir>/<Artist>/<Album>/<NN - Title>.<ext>`.
   */
  async organizeBatch(files: CompletedDownloadFile[]): Promise<OrganizeResult> {
    const result: OrganizeResult = {
      moved: 0,
      skipped: 0,
      unsorted: 0,
      failed: 0,
      dedupedBasenames: [],
    };
    if (files.length === 0) return result;

    this.touchedAlbumDirs.clear();

    const groups = new Map<string, CompletedDownloadFile[]>();
    for (const file of files) {
      const g = groups.get(file.directory) ?? [];
      g.push(file);
      groups.set(file.directory, g);
    }

    for (const [directory, groupFiles] of groups) {
      await this.organizeGroup(directory, groupFiles, result);
    }

    if (this.autoDedupe) {
      for (const dir of this.touchedAlbumDirs) {
        const { deleted } = dedupeFolder(dir, { apply: true });
        for (const d of deleted) {
          result.dedupedBasenames.push(basename(d.name).toLowerCase());
          log.info(
            { dir, dropped: d.name, kept: d.keptName },
            'Auto-dedupe removed a duplicate copy',
          );
        }
      }
    }

    return result;
  }

  /**
   * Organize a single on-disk audio file (used by the backfill script when
   * iterating the filesystem rather than the completed_downloads table).
   */
  async organizeFile(
    absPath: string,
    peerDirectory?: string,
  ): Promise<'moved' | 'skipped' | 'unsorted' | 'failed'> {
    const flat = this.flattenPhantomDir(absPath);
    const finalSrc = flat ?? absPath;
    if (!existsSync(finalSrc)) return 'failed';

    const tags = await this.readWithFallback(
      finalSrc,
      peerDirectory ?? basename(dirname(finalSrc)),
    );
    const resolved: ResolvedFile = {
      srcPath: finalSrc,
      peerDirectory: peerDirectory ?? basename(dirname(finalSrc)),
      filename: basename(finalSrc),
      tags,
    };
    const folderTags = this.deriveFolderTags([resolved]);
    return this.placeFile(resolved, folderTags);
  }

  private async organizeGroup(
    directory: string,
    groupFiles: CompletedDownloadFile[],
    result: OrganizeResult,
  ): Promise<void> {
    const resolved: ResolvedFile[] = [];

    for (const file of groupFiles) {
      const src = this.locateOnDisk(file);
      if (!src) {
        log.warn({ directory, filename: file.filename }, 'Could not locate file on disk');
        result.failed++;
        continue;
      }
      const ext = extname(src).toLowerCase();
      if (!AUDIO_EXTS.has(ext)) {
        result.skipped++;
        continue;
      }
      const flat = this.flattenPhantomDir(src);
      const finalSrc = flat ?? src;
      const tags = await this.readWithFallback(finalSrc, directory);
      resolved.push({
        srcPath: finalSrc,
        peerDirectory: directory,
        filename: file.filename,
        tags,
        source: file,
      });
    }

    if (resolved.length === 0) return;

    const folderTags = this.applyJobCanonicalName(directory, this.deriveFolderTags(resolved));

    for (const r of resolved) {
      const outcome = await this.placeFile(r, folderTags);
      if (outcome === 'moved') result.moved++;
      else if (outcome === 'skipped') result.skipped++;
      else if (outcome === 'unsorted') result.unsorted++;
      else result.failed++;
    }
  }

  /**
   * Read tags from disk; if artist/title missing, infer from filename;
   * if still missing and AcoustID is configured, fingerprint and write
   * tags back to the file.
   */
  /**
   * If this peer directory was recorded as an album hunt, name the destination
   * folder after the Lidarr canonical album (overriding the peer's edition tag)
   * so every edition/re-hunt of the album lands in one `<Artist>/<album>` dir.
   * No match → tags pass through unchanged.
   */
  private applyJobCanonicalName(directory: string, tags: AlbumTags): AlbumTags {
    const job = this.jobLookup?.(directory);
    if (!job?.album) return tags;
    const canonicalAlbum = sanitizeAlbumTag(normalizeTagValue(job.album));
    if (!canonicalAlbum) return tags;
    const albumArtist =
      tags.albumArtist ??
      (job.artist ? sanitizeArtistTag(normalizeTagValue(job.artist)) : undefined);
    return { ...tags, album: canonicalAlbum, albumArtist };
  }

  private async readWithFallback(path: string, peerDirectory: string): Promise<AudioTags> {
    const tags = await readAudioTags(path);
    let artist = sanitizeArtistTag(normalizeTagValue(tags.artist));
    let title = normalizeTagValue(tags.title);
    let album = sanitizeAlbumTag(normalizeTagValue(tags.album));
    // Existing title that's just a filename leak ("01-Demasiado", "05. LA SED VERDADERA").
    // Strict pattern (requires .)\-_ separator) avoids stripping legit titles like "99 Red Balloons".
    if (title) {
      const m = title.match(/^\s*(\d{1,3})\s*[.)\-_]\s*(\S.*)$/);
      if (m) {
        if (tags.trackNumber === undefined) tags.trackNumber = Number(m[1]);
        title = m[2].trim();
      }
    }
    const albumArtistClean = sanitizeArtistTag(normalizeTagValue(tags.albumArtist));
    if (albumArtistClean !== normalizeTagValue(tags.albumArtist)) {
      tags.albumArtist = albumArtistClean;
    }
    // Reflect cleanup back to tags so deriveFolderTags() sees the corrected values
    tags.artist = artist;
    tags.album = album;

    if (!artist || !title) {
      const inferred = inferMetadataFromPath(basename(path), peerDirectory);
      artist = artist ?? normalizeTagValue(inferred.artist);
      title = title ?? normalizeTagValue(inferred.title);
      album = album ?? normalizeTagValue(inferred.album);
      if (inferred.trackNumber && tags.trackNumber === undefined) {
        tags.trackNumber = Number(inferred.trackNumber);
      }
    }

    // Folder-derived album that just echoes the artist (e.g. file lives in
    // <Artist>/file.mp3 with no real album tag) isn't a real album. Drop it
    // so the Singles fallback in placeFile kicks in.
    if (
      album &&
      artist &&
      stripAccents(album).toLowerCase().trim() === stripAccents(artist).toLowerCase().trim()
    ) {
      album = undefined;
    }

    // Skip the AcoustID round-trip if we've already fingerprinted this file
    // in a prior run — the ACOUSTID_ID tag is our negative cache marker.
    const alreadyFingerprinted = !!tags.acoustIdId;

    if ((!artist || !title) && this.acoustid && !alreadyFingerprinted) {
      const hit = await this.acoustid.lookup(path);
      if (hit) {
        // Always persist the AcoustID — even when no MB metadata came back —
        // so a re-run can skip the fingerprint+HTTP round-trip on this file.
        tags.acoustIdId = hit.acoustId;
        if (hit.recordingId) tags.mbRecordingId = hit.recordingId;
        if (hit.releaseId) tags.mbReleaseId = hit.releaseId;
        if (hit.artist || hit.title) {
          artist = artist ?? normalizeTagValue(hit.artist);
          title = title ?? normalizeTagValue(hit.title);
          album = album ?? normalizeTagValue(hit.album);
          if (!tags.albumArtist) tags.albumArtist = hit.albumArtist;
          if (tags.year === undefined) tags.year = hit.year;
          if (tags.trackNumber === undefined) tags.trackNumber = hit.trackNumber;
          log.info({ path, score: hit.score, recordingId: hit.recordingId }, 'AcoustID matched');
        } else {
          log.debug(
            { path, score: hit.score, acoustId: hit.acoustId },
            'AcoustID fingerprint matched, no MB metadata',
          );
        }
        await writeAudioTags(path, {
          artist,
          title,
          album,
          albumArtist: tags.albumArtist,
          year: tags.year,
          trackNumber: tags.trackNumber,
          acoustIdId: tags.acoustIdId,
          mbRecordingId: tags.mbRecordingId,
          mbReleaseId: tags.mbReleaseId,
        });
      }
    }

    return { ...tags, artist, title, album };
  }

  /** Derives album-level tags for the group (compilation vs single-artist). */
  private deriveFolderTags(files: ResolvedFile[]): AlbumTags {
    if (files.length === 1) {
      const t = files[0]!.tags;
      const albumArtist = normalizeTagValue(t.albumArtist) ?? normalizeTagValue(t.artist);
      // When the file has no album tag, try to derive one from the peer-side
      // directory name (e.g. peer path "Artist\Dark Side of the Moon\track.flac"
      // → album "Dark Side of the Moon"). Generic and artist-echo folders are
      // filtered out so "src/", "downloads/", or "<Artist>/" don't become albums.
      const album =
        normalizeTagValue(t.album) ?? inferFolderAlbum(files[0]!.peerDirectory, albumArtist);
      return {
        album,
        albumArtist,
        compilation: t.compilation === true,
        year: t.year ?? parseYearFromFolder(files[0]!.peerDirectory),
      };
    }

    const signals = files.map((f) => ({
      artist: normalizeTagValue(f.tags.artist),
      album: normalizeTagValue(f.tags.album),
      filename: f.filename,
    }));
    const classification = classifyFolder(signals, files[0]!.peerDirectory);
    return classificationToAlbumTags(classification, files);
  }

  private async placeFile(
    file: ResolvedFile,
    folderTags: AlbumTags,
  ): Promise<'moved' | 'skipped' | 'unsorted' | 'failed'> {
    const ext = extname(file.srcPath).toLowerCase();
    const tags = file.tags;

    const artist = normalizeTagValue(tags.artist);
    const albumArtist = folderTags.albumArtist ?? normalizeTagValue(tags.albumArtist) ?? artist;
    const album = folderTags.album ?? normalizeTagValue(tags.album);
    const title = normalizeTagValue(tags.title);

    // Decide destination
    const folderArtist = folderTags.compilation
      ? 'Various Artists'
      : sanitizeSegment(albumArtist ?? '');
    const folderAlbum = sanitizeSegment(album ?? '');
    const trackTitle = sanitizeSegment(title ?? basename(file.filename).replace(/\.[^/.]+$/, ''));

    const unsortedDir = isAbsolute(this.unsortedRoot)
      ? this.unsortedRoot
      : join(this.musicDir, this.unsortedRoot);
    let destDir: string;
    if (folderArtist && folderAlbum && trackTitle) {
      destDir = join(this.musicDir, folderArtist, folderAlbum);
      // Only real <Artist>/<Album> dirs are dedupe targets — never Singles (many
      // distinct tracks) or the unsorted bucket.
      this.touchedAlbumDirs.add(destDir);
    } else if (folderArtist && trackTitle) {
      // Single artist, no album info → place under <Artist>/Singles/ on disk,
      // but leave the album tag empty (no longer force "Singles"): the scanner
      // turns each album-less track into its own single release named after the
      // title, so loose tracks become individual cards instead of one hidden
      // "Singles" bucket. (See isLooseSinglesBucket in library-scanner.ts.)
      destDir = join(this.musicDir, folderArtist, 'Singles');
    } else if (trackTitle) {
      // No artist info at all
      const cleanedPeer = stripAudioExt(file.peerDirectory);
      const stripped = stripTrackPrefix(cleanFolderName(cleanedPeer));
      const sourceFolder = sanitizeSegment(stripped || cleanFolderName(cleanedPeer) || 'Unknown');
      destDir = join(unsortedDir, sourceFolder);
    } else {
      destDir = join(unsortedDir, '_no_title');
    }

    const trackName =
      `${trackNumberPrefix(tags.trackNumber)}${trackTitle || basename(file.srcPath)}${ext}`.replace(
        /(\.[^.]+)\1$/,
        '$1',
      );

    // Format-preference dedup: drop an incoming MP3 when the same track already
    // exists as FLAC in the destination album folder, so we don't accumulate the
    // mixed-format duplicate albums the usage analysis flagged.
    if (this.preferFlacSkipMp3 && ext === '.mp3' && flacTwinExists(destDir, trackTitle || title)) {
      log.info({ src: file.srcPath, destDir }, 'Skipping MP3 — FLAC of this track already present');
      if (file.source) file.source.relativePath = undefined;
      try {
        unlinkSync(file.srcPath);
      } catch {
        /* source already gone — fine */
      }
      return 'skipped';
    }

    const destPath = uniquePath(join(destDir, trackName), file.srcPath);

    const samePath = destPath === file.srcPath;
    if (!samePath) {
      try {
        mkdirSync(destDir, { recursive: true });
        moveFileAcrossDevices(file.srcPath, destPath);
      } catch (err) {
        log.warn({ err, src: file.srcPath, dst: destPath }, 'Move failed');
        return 'failed';
      }
      this.logMove(file.srcPath, destPath);
    }

    // Tag rewrite step — run even when the file didn't move, so junk
    // album/artist tags from a prior run get cleaned up idempotently. Loose
    // singles get no forced album tag (the scanner derives album = title).
    const effectiveAlbum = folderTags.album;
    const currentRaw = await readAudioTags(destPath);
    const toWrite: AudioTags = {};
    if (effectiveAlbum && currentRaw.album !== effectiveAlbum) toWrite.album = effectiveAlbum;
    if (folderTags.albumArtist && currentRaw.albumArtist !== folderTags.albumArtist) {
      toWrite.albumArtist = folderTags.albumArtist;
    }
    if (folderTags.compilation && !currentRaw.compilation) toWrite.compilation = true;
    if (folderTags.year !== undefined && currentRaw.year !== folderTags.year) {
      toWrite.year = folderTags.year;
    }
    // Also clean up artist if it had leading junk we stripped
    if (tags.artist && currentRaw.artist !== tags.artist) toWrite.artist = tags.artist;
    if (tags.title && currentRaw.title !== tags.title) toWrite.title = tags.title;
    if (tags.trackNumber !== undefined && currentRaw.trackNumber !== tags.trackNumber) {
      toWrite.trackNumber = tags.trackNumber;
    }
    if (Object.keys(toWrite).length > 0) {
      try {
        await writeAudioTags(destPath, toWrite);
      } catch {
        /* non-fatal */
      }
    }

    // Record where the file ended up so callers (download-watcher → auto-playlist)
    // can map slskd completion records to Navidrome song paths after the move.
    if (file.source) {
      const rel = relative(this.musicDir, destPath).replace(/\\/g, '/');
      if (rel && !rel.startsWith('../') && rel !== '..') {
        file.source.relativePath = rel;
      }
    }

    if (samePath) {
      // The move was a no-op but we may have cleaned tags above.
      const wasUnsortedSame = file.srcPath.startsWith(unsortedDir);
      return wasUnsortedSame ? 'unsorted' : 'skipped';
    }

    // Cleanup empty source dirs (bounded walk-up, never crosses staging/music root)
    const stopAt = this.stagingDir ?? this.musicDir;
    pruneEmptyAncestors(dirname(file.srcPath), stopAt);

    const wasUnsorted = destPath.startsWith(unsortedDir);
    return wasUnsorted ? 'unsorted' : 'moved';
  }

  /**
   * If `path` lives inside a directory whose basename equals the file's
   * basename (slskd's phantom-dir pattern when downloading a single file),
   * move the file one level up and return the new path. Otherwise null.
   */
  private flattenPhantomDir(path: string): string | null {
    const parent = dirname(path);
    const parentName = basename(parent);
    const fileName = basename(path);
    if (parentName !== fileName) return null;

    // The parent must contain only this one audio file
    let siblings: string[];
    try {
      siblings = readdirSync(parent);
    } catch {
      return null;
    }
    if (siblings.length !== 1) return null;

    const grandparent = dirname(parent);
    if (grandparent === parent) return null;

    const newPath = join(grandparent, fileName);
    if (existsSync(newPath) && newPath !== path) return null;

    try {
      renameSync(path, newPath);
      try {
        rmdirSync(parent);
      } catch {
        /* ignore */
      }
      this.logMove(path, newPath);
      return newPath;
    } catch {
      return null;
    }
  }

  /** Find the file on disk given slskd's reported directory/filename pair. */
  private locateOnDisk(file: CompletedDownloadFile): string | null {
    // yt-dlp sets filename to an absolute path; check it first before trying
    // the slskd peer-relative path logic below.
    if (
      isAbsolute(file.filename) &&
      existsSync(file.filename) &&
      statSync(file.filename).isFile()
    ) {
      return file.filename;
    }

    const filenameParts = file.filename.replace(/\\/g, '/').split('/').filter(Boolean);
    const directoryParts = file.directory.replace(/\\/g, '/').split('/').filter(Boolean);
    const baseName = filenameParts[filenameParts.length - 1] ?? file.filename;
    const leafDir = directoryParts[directoryParts.length - 1];

    const roots: string[] = [];
    if (this.stagingDir) roots.push(this.stagingDir);
    roots.push(this.musicDir);

    for (const root of roots) {
      const candidates = [
        join(root, ...filenameParts),
        join(root, ...directoryParts, baseName),
        ...(leafDir ? [join(root, leafDir, baseName)] : []),
        join(root, baseName),
        // phantom: <root>/<leaf>/<file>/<file>
        ...(leafDir ? [join(root, leafDir, baseName, baseName)] : []),
        join(root, baseName, baseName),
      ];
      for (const c of candidates) {
        if (existsSync(c) && statSync(c).isFile()) return c;
      }
    }
    return null;
  }

  private logMove(src: string, dst: string): void {
    if (!this.moveLogPath) return;
    try {
      appendFileSync(this.moveLogPath, `${src}\t${dst}\n`, 'utf-8');
    } catch {
      /* non-fatal */
    }
  }
}

interface AlbumTags {
  album?: string;
  albumArtist?: string;
  compilation: boolean;
  year?: number;
}

function classificationToAlbumTags(c: Classification, files: ResolvedFile[]): AlbumTags {
  if (c.type === 'single-artist') {
    return { album: c.album, albumArtist: c.artist, compilation: false, year: c.year };
  }
  if (c.type === 'compilation') {
    return { album: c.album, albumArtist: 'Various Artists', compilation: true, year: c.year };
  }
  // leave-alone: take consensus from tags
  const albums = new Set(
    files.map((f) => normalizeTagValue(f.tags.album)).filter((v): v is string => !!v),
  );
  const albumArtists = new Set(
    files
      .map((f) => normalizeTagValue(f.tags.albumArtist) ?? normalizeTagValue(f.tags.artist))
      .filter((v): v is string => !!v),
  );
  const folderName = files[0]?.peerDirectory ?? '';
  const fallbackAlbum =
    files[0] && normalizeTagValue(files[0].tags.album)
      ? normalizeTagValue(files[0].tags.album)
      : extractAlbumName(folderName, [...albumArtists][0]);
  return {
    album: albums.size === 1 ? [...albums][0] : fallbackAlbum,
    albumArtist: albumArtists.size === 1 ? [...albumArtists][0] : undefined,
    compilation: false,
    year: parseYearFromFolder(folderName),
  };
}

function uniquePath(desired: string, sourcePath: string): string {
  if (!existsSync(desired) || desired === sourcePath) return desired;
  // collision: append counter
  const ext = extname(desired);
  const stem = desired.slice(0, desired.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    const cand = `${stem} (${i})${ext}`;
    if (!existsSync(cand) || cand === sourcePath) return cand;
  }
  return desired;
}

function pruneEmptyAncestors(dir: string, stopAt: string): void {
  const norm = (p: string) => p.replace(/\/+$/, '');
  const stop = norm(stopAt);
  let cur = norm(dir);
  while (cur && cur !== stop && cur.startsWith(stop + '/')) {
    try {
      const entries = readdirSync(cur);
      if (entries.length > 0) return;
      rmdirSync(cur);
    } catch {
      return;
    }
    cur = norm(dirname(cur));
  }
}

function expandHome(p: string): string {
  return p.startsWith('~') ? join(process.env.HOME ?? '/root', p.slice(1)) : p;
}

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** rename, falling back to copy+unlink when src/dst are on different filesystems (EXDEV). */
/**
 * True if an existing FLAC in `destDir` has the same (normalized) track title as
 * the incoming file — used to skip a redundant MP3 download. Compares with the
 * shared diacritic-folding normalizer so "01 - Canción.flac" matches "cancion".
 */
function flacTwinExists(destDir: string, trackTitle: string | undefined): boolean {
  if (!trackTitle || !existsSync(destDir)) return false;
  const target = normalizeTitle(trackTitle);
  if (!target) return false;
  try {
    for (const entry of readdirSync(destDir)) {
      if (extname(entry).toLowerCase() !== '.flac') continue;
      const base = entry.slice(0, entry.lastIndexOf('.'));
      if (normalizeTitle(base) === target) return true;
    }
  } catch {
    // Unreadable destination dir — treat as no twin and let the normal path run.
  }
  return false;
}

function moveFileAcrossDevices(src: string, dst: string): void {
  try {
    renameSync(src, dst);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw err;
    copyFileSync(src, dst);
    unlinkSync(src);
  }
}

/**
 * Some peers tag tracks with `"01. Artist Name"` / `"03) Artist"` etc.
 * Strip a leading track-number prefix; if the value is *only* a track number,
 * discard it entirely (returns undefined). Also returns undefined for the
 * literal extension form, since that means the tag was a filename.
 */
function sanitizeArtistTag(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  if (isTrackNumberFragment(raw)) return undefined;
  let v = stripTrackPrefix(raw);
  if (!v) return undefined;
  v = stripArtistLeadJunk(v);
  v = stripFeaturingSuffix(v);
  if (!v || isTrackNumberFragment(v)) return undefined;
  return v;
}

/**
 * Drop album values that are actually filename leakage (`"01 - Track.mp3"`)
 * or pure track-number fragments. Real albums occasionally have leading
 * numbers (e.g. `"1989"`) — we only reject when there's also a track-style
 * separator or audio extension.
 */
function sanitizeAlbumTag(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  if (looksLikeFilenameTag(raw)) return undefined;
  if (isTrackNumberFragment(raw)) return undefined;
  return raw;
}
