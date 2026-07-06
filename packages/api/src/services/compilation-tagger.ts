import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { cleanFolderName, createLogger, parseYearFromFolder } from '@nicotind/core';
import { extractAlbumName, inferMetadataFromPath } from './path-inference.js';
import type { CompletedDownloadFile } from './path-inference.js';

const log = createLogger('compilation-tagger');

interface CompilationTaggerOptions {
  musicDir: string;
  enabled?: boolean;
}

interface AlbumTags {
  album: string;
  albumArtist: string;
  compilation: boolean;
  year?: number;
}

interface FileSignal {
  artist: string | undefined;
  album: string | undefined;
  albumArtist: string | undefined;
  compilation: boolean | undefined;
  filename: string;
}

export type Classification =
  | { type: 'leave-alone' }
  | { type: 'single-artist'; artist: string; album: string; year?: number }
  | { type: 'compilation'; album: string; year?: number };

const COMPILATION_NAME_REGEXES: RegExp[] = [
  /^\s*va\b/i,
  /\bvarious\s+artists?\b/i,
  /\b(best\s+of|top\s+\d+|compilation|comp|sampler|anthology|hits|mixtape)\b/i,
  /\bvol\.?\s*\d+\b/i,
];

function looksLikeCompilationName(folderName: string): boolean {
  return COMPILATION_NAME_REGEXES.some((re) => re.test(folderName));
}

const VA_PATTERNS = /^(various\s*artists?|va|v\.?\s*a\.?|v\s*\/\s*a)$/i;

export function isVariousArtists(name: string): boolean {
  return VA_PATTERNS.test(name.trim());
}

function normalizeTag(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const lower = trimmed.toLowerCase();
  if (
    lower === 'unknown' ||
    lower === 'unknown artist' ||
    lower === 'unknown album' ||
    lower === 'unknown title'
  ) {
    return undefined;
  }
  return trimmed;
}

function consensusValue(values: Array<string | undefined>): string | undefined {
  const counts = new Map<string, { count: number; example: string }>();
  for (const v of values) {
    if (v === undefined) continue;
    const key = v.toLowerCase();
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { count: 1, example: v });
  }
  let best: { count: number; example: string } | undefined;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return best?.example;
}

/**
 * Decides what to do with a folder of completed downloads.
 *
 * Three outcomes:
 *   - `leave-alone`     : already coherent; touch nothing.
 *   - `single-artist`   : all files agree on artist; consolidate the album.
 *   - `compilation`     : multi-artist mix; rewrite as VA + COMPILATION=1.
 *
 * Inputs are post-normalized: empty / "Unknown" / "Unknown Album" come
 * through as `undefined`. Length ≥ 2 is guaranteed by the caller.
 *
 * Rule evaluation order (first match wins):
 *   1. Existing COMPILATION flag or VA albumArtist in tags → compilation.
 *   2. Coherent album + single artist → leave-alone (well-tagged, don't touch).
 *   3. Single-artist consensus (1 distinct artist, ≤25% missing) → single-artist.
 *   4. Folder name shouts comp → compilation.
 *   5. Coherent album + ≥3 artists → compilation (classic VA pattern).
 *   6. ≥5 distinct artists → compilation.
 *   7. ≥6 files AND ≥75% artist-missing AND ≥75% album-missing → compilation.
 *   8. Otherwise → leave-alone.
 */
export function classifyFolder(files: FileSignal[], folderName: string): Classification {
  const total = files.length;

  const albums = files.map((f) => f.album);
  const artists = files.map((f) => f.artist);

  const nonEmptyAlbums = albums.filter((a): a is string => a !== undefined);
  const nonEmptyArtists = artists.filter((a): a is string => a !== undefined);

  const distinctAlbums = new Set(nonEmptyAlbums.map((a) => a.toLowerCase())).size;
  const distinctArtists = new Set(nonEmptyArtists.map((a) => a.toLowerCase())).size;

  const albumMissingFraction = (total - nonEmptyAlbums.length) / total;
  const artistMissingFraction = (total - nonEmptyArtists.length) / total;

  const year = parseYearFromFolder(folderName);

  // 1. Existing COMPILATION flag or VA album artist in tags — trust the source.
  const hasCompilationFlag = files.some((f) => f.compilation === true);
  const hasVaAlbumArtist = files.some(
    (f) => f.albumArtist !== undefined && isVariousArtists(f.albumArtist),
  );
  if (hasCompilationFlag || hasVaAlbumArtist) {
    const album =
      distinctAlbums === 1 ? nonEmptyAlbums[0]! : cleanFolderName(folderName);
    return { type: 'compilation', album, year };
  }

  // 2. Coherent album + single artist → already well-tagged, don't rewrite.
  if (distinctAlbums === 1 && albumMissingFraction === 0 && distinctArtists <= 1) {
    return { type: 'leave-alone' };
  }

  // 3. Single-artist consolidation
  if (distinctArtists === 1 && artistMissingFraction <= 0.25) {
    const artist = consensusValue(artists) ?? nonEmptyArtists[0]!;
    return {
      type: 'single-artist',
      artist,
      album: extractAlbumName(folderName, artist),
      year,
    };
  }

  // 4. Folder name shouts compilation
  if (looksLikeCompilationName(folderName)) {
    return { type: 'compilation', album: cleanFolderName(folderName), year };
  }

  // 5. Coherent album + multiple artists → the tracks were intentionally
  //    grouped under one album name by different artists (classic VA pattern).
  if (distinctAlbums === 1 && albumMissingFraction === 0 && distinctArtists >= 3) {
    return { type: 'compilation', album: nonEmptyAlbums[0]!, year };
  }

  // 6. Scattered artists (5+ distinct)
  if (distinctArtists >= 5) {
    return { type: 'compilation', album: cleanFolderName(folderName), year };
  }

  // 7. Untagged sizable dump
  if (total >= 6 && artistMissingFraction >= 0.75 && albumMissingFraction >= 0.75) {
    return { type: 'compilation', album: cleanFolderName(folderName), year };
  }

  return { type: 'leave-alone' };
}

type NodeId3Api = {
  read: (filepath: string) => Record<string, unknown> | false | undefined;
  update: (tags: Record<string, string>, filepath: string) => boolean;
};

type MusicMetadataCommon = { album?: string; artist?: string; albumartist?: string };
type MusicMetadataApi = {
  parseFile: (
    path: string,
    opts?: { duration?: boolean },
  ) => Promise<{ common: MusicMetadataCommon }>;
};

let nodeId3Promise: Promise<NodeId3Api | null> | null = null;
let nodeId3MissingLogged = false;

async function getNodeId3(): Promise<NodeId3Api | null> {
  if (!nodeId3Promise) {
    nodeId3Promise = import('node-id3')
      .then((mod) => (mod.default ?? mod) as unknown as NodeId3Api)
      .catch((err) => {
        if (!nodeId3MissingLogged) {
          nodeId3MissingLogged = true;
          log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'node-id3 not installed, MP3 tagging disabled',
          );
        }
        return null;
      });
  }
  return nodeId3Promise;
}

let mmPromise: Promise<MusicMetadataApi | null> | null = null;
let mmMissingLogged = false;

async function getMusicMetadata(): Promise<MusicMetadataApi | null> {
  if (!mmPromise) {
    mmPromise = import('music-metadata')
      .then((mod) => mod as unknown as MusicMetadataApi)
      .catch((err) => {
        if (!mmMissingLogged) {
          mmMissingLogged = true;
          log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'music-metadata not installed, FLAC/OGG/OPUS tagging disabled',
          );
        }
        return null;
      });
  }
  return mmPromise;
}

const ID3_EXTS = new Set(['.mp3']);
const VORBIS_EXTS = new Set(['.flac', '.ogg', '.opus']);

/**
 * Folder-aware compilation tagger. Runs after a batch of downloads
 * completes; groups files by their slskd directory; classifies each
 * folder; and writes a uniform set of album-level tags for the
 * single-artist and compilation paths. Per-track ARTIST and TITLE are
 * NEVER overwritten — the rewrite is strictly album-level.
 */
export class CompilationTagger {
  private musicDir: string;
  private enabled: boolean;

  constructor(options: CompilationTaggerOptions) {
    this.musicDir = this.expandDir(options.musicDir);
    this.enabled = options.enabled ?? true;
  }

  async tagCompletedFolders(files: CompletedDownloadFile[]): Promise<void> {
    if (!this.enabled || files.length === 0) return;

    const groups = new Map<string, CompletedDownloadFile[]>();
    for (const file of files) {
      const group = groups.get(file.directory) ?? [];
      group.push(file);
      groups.set(file.directory, group);
    }

    for (const [directory, groupFiles] of groups) {
      const folderSize = Math.max(groupFiles.length, groupFiles[0]?.directoryFileCount ?? 0);
      if (folderSize < 2) continue;
      await this.processFolder(directory, groupFiles);
    }
  }

  private async processFolder(
    directory: string,
    groupFiles: CompletedDownloadFile[],
  ): Promise<void> {
    const resolved: Array<{ path: string; signal: FileSignal }> = [];
    for (const file of groupFiles) {
      const path = this.resolveLocalPath(file.directory, file.filename);
      if (!path) continue;
      const ext = extname(path).toLowerCase();
      if (!ID3_EXTS.has(ext) && !VORBIS_EXTS.has(ext)) continue;

      const tags = await this.readFileTags(path, ext);
      const filename = file.filename;
      let artist = normalizeTag(tags.artist);
      const album = normalizeTag(tags.album);
      const albumArtist = normalizeTag(tags.albumArtist);

      if (!artist) {
        const inferred = inferMetadataFromPath(filename, file.directory);
        artist = normalizeTag(inferred.artist);
      }

      resolved.push({
        path,
        signal: { artist, album, albumArtist, compilation: tags.compilation, filename },
      });
    }

    if (resolved.length < 2) return;

    const result = classifyFolder(
      resolved.map((r) => r.signal),
      directory,
    );

    if (result.type === 'leave-alone') {
      log.debug({ directory, files: resolved.length }, 'Folder is coherent, skipping tag rewrite');
      return;
    }

    const albumTags: AlbumTags =
      result.type === 'single-artist'
        ? {
            album: result.album,
            albumArtist: result.artist,
            compilation: false,
            year: result.year,
          }
        : {
            album: result.album,
            albumArtist: 'Various Artists',
            compilation: true,
            year: result.year,
          };

    let written = 0;
    for (const { path } of resolved) {
      const ok = await this.writeAlbumTags(path, albumTags);
      if (ok) written++;
    }

    log.info(
      { directory, classification: result.type, total: resolved.length, written, tags: albumTags },
      'Applied folder tags',
    );
  }

  private async readFileTags(
    filepath: string,
    ext: string,
  ): Promise<{ artist?: string; album?: string; albumArtist?: string; compilation?: boolean }> {
    if (ID3_EXTS.has(ext)) {
      const nodeId3 = await getNodeId3();
      if (!nodeId3) return {};
      try {
        const raw = nodeId3.read(filepath);
        const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
        return {
          artist: typeof data.artist === 'string' ? data.artist : undefined,
          album: typeof data.album === 'string' ? data.album : undefined,
          albumArtist:
            typeof data.performerInfo === 'string' ? data.performerInfo : undefined,
          compilation:
            Array.isArray(data.userDefinedText) &&
            (data.userDefinedText as Array<Record<string, string>>).some(
              (t) => t.description === 'COMPILATION' && t.value === '1',
            )
              ? true
              : undefined,
        };
      } catch {
        return {};
      }
    }
    if (VORBIS_EXTS.has(ext)) {
      const mm = await getMusicMetadata();
      if (!mm) return {};
      try {
        const parsed = await mm.parseFile(filepath, { duration: false });
        return {
          artist: parsed.common.artist,
          album: parsed.common.album,
          albumArtist: parsed.common.albumartist,
          compilation: (parsed.common as Record<string, unknown>).compilation === true ? true : undefined,
        };
      } catch {
        return {};
      }
    }
    return {};
  }

  private async writeAlbumTags(filepath: string, tags: AlbumTags): Promise<boolean> {
    const ext = extname(filepath).toLowerCase();
    if (ID3_EXTS.has(ext)) return this.writeId3AlbumTags(filepath, tags);
    if (VORBIS_EXTS.has(ext)) return this.writeFfmpegAlbumTags(filepath, tags);
    return false;
  }

  private async writeId3AlbumTags(filepath: string, tags: AlbumTags): Promise<boolean> {
    const nodeId3 = await getNodeId3();
    if (!nodeId3) return false;

    const update: Record<string, string> = {
      album: tags.album,
      performerInfo: tags.albumArtist,
    };
    if (tags.year !== undefined) update.year = String(tags.year);
    if (tags.compilation) update.TCMP = '1';

    try {
      const ok = nodeId3.update(update, filepath);
      if (!ok) log.warn({ filepath }, 'node-id3 update returned false');
      return ok;
    } catch (err) {
      log.warn({ err, filepath }, 'Failed to write ID3 album tags');
      return false;
    }
  }

  private async writeFfmpegAlbumTags(filepath: string, tags: AlbumTags): Promise<boolean> {
    const tmpPath = filepath + '.nicotind.tmp';
    const metaArgs: string[] = [
      '-metadata',
      `ALBUM=${tags.album}`,
      '-metadata',
      `ALBUMARTIST=${tags.albumArtist}`,
    ];
    if (tags.compilation) metaArgs.push('-metadata', 'COMPILATION=1');
    if (tags.year !== undefined) metaArgs.push('-metadata', `DATE=${tags.year}`);

    const args = ['-y', '-i', filepath, '-map_metadata', '0', ...metaArgs, '-c', 'copy', tmpPath];

    return new Promise<boolean>((resolve) => {
      const proc = spawn('ffmpeg', args, { stdio: 'ignore' });
      proc.on('error', () => {
        try {
          unlinkSync(tmpPath);
        } catch {
          /* ignore */
        }
        resolve(false);
      });
      proc.on('close', (code) => {
        if (code === 0) {
          try {
            renameSync(tmpPath, filepath);
            resolve(true);
          } catch {
            try {
              unlinkSync(tmpPath);
            } catch {
              /* ignore */
            }
            resolve(false);
          }
        } else {
          try {
            unlinkSync(tmpPath);
          } catch {
            /* ignore */
          }
          resolve(false);
        }
      });
    });
  }

  private resolveLocalPath(directory: string, filename: string): string | null {
    const filenameSegments = filename.split(/[\\/]+/).filter(Boolean);
    const directorySegments = directory.split(/[\\/]+/).filter(Boolean);
    const baseName = filenameSegments[filenameSegments.length - 1] ?? filename;

    const candidates: string[] = [
      join(this.musicDir, ...filenameSegments),
      join(this.musicDir, ...directorySegments, baseName),
      join(this.musicDir, baseName),
    ];

    if (this.isAbsolutePath(filename)) {
      candidates.unshift(filename.replace(/\\/g, '/'));
    }

    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  private expandDir(dir: string): string {
    if (dir.startsWith('~')) {
      return join(process.env.HOME ?? '/root', dir.slice(1));
    }
    return dir;
  }

  private isAbsolutePath(p: string): boolean {
    return p.startsWith('/') || /^[a-zA-Z]:\\/.test(p);
  }
}
