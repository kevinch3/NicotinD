import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { createLogger } from '@nicotind/core';

const log = createLogger('metadata-fixer');

export interface CompletedDownloadFile {
  username: string;
  directory: string;
  filename: string;
  relativePath?: string | null;
  directoryFileCount?: number;
}

export interface ParsedMetadata {
  title?: string;
  artist?: string;
  album?: string;
  trackNumber?: string;
}

export interface ReprocessStats {
  processed: number;
  total: number;
  fixed: number;
  skipped: number;
  errors: number;
}

export interface OrganizeChange {
  from: string;
  to: string;
  reason: string;
}

export interface OrganizeStats extends ReprocessStats {
  renamed: number;
  dryRun: boolean;
  changes: OrganizeChange[];
}

export function sanitizePathComponent(s: string): string {
  const cleaned = s
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
  return (cleaned.slice(0, 200) || '_');
}

export function buildCanonicalPath(musicDir: string, meta: ParsedMetadata, ext: string): string {
  const artist = sanitizePathComponent(meta.artist || 'Unknown Artist');
  const title = sanitizePathComponent(meta.title || 'Unknown');
  const track = meta.trackNumber ? String(Number(meta.trackNumber)).padStart(2, '0') : null;
  const filename = (track ? `${track} - ${title}` : title) + ext;
  if (hasUsableValue(meta.album)) {
    const album = sanitizePathComponent(meta.album!);
    return join(musicDir, artist, album, filename);
  }
  return join(musicDir, artist, filename);
}

interface MetadataFixerOptions {
  musicDir: string;
  enabled?: boolean;
  minScore?: number;
  fetchFn?: typeof fetch;
}

interface MusicBrainzRecording {
  title?: string;
  score?: number | string;
  'artist-credit'?: Array<{
    name?: string;
    artist?: { name?: string };
  }>;
  releases?: Array<{ title?: string }>;
}

interface MusicBrainzResponse {
  recordings?: MusicBrainzRecording[];
}

type NodeId3Api = {
  read: (filepath: string) => Record<string, unknown> | false | undefined;
  update: (tags: Record<string, string>, filepath: string) => boolean;
};

type MusicMetadataCommon = {
  title?: string;
  artist?: string;
  album?: string;
  track?: { no?: number | null };
};

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
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(
            { err: msg },
            'node-id3 is not installed, MP3 metadata repair is disabled',
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
          const msg = err instanceof Error ? err.message : String(err);
          log.warn({ err: msg }, 'music-metadata is not installed, FLAC/OPUS metadata repair is disabled');
        }
        return null;
      });
  }
  return mmPromise;
}

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.ogg', '.opus', '.m4a']);

function* walkAudioFiles(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkAudioFiles(full);
    } else if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      yield full;
    }
  }
}

function splitPathSegments(input: string): string[] {
  return input.split(/[\\/]+/).filter(Boolean);
}

function cleanToken(input: string): string {
  return input.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = cleanToken(value);
  return cleaned.length > 0 ? cleaned : undefined;
}

function isUnknownLike(value: string | undefined): boolean {
  if (!value) return true;
  const normalized = value
    .toLowerCase()
    .replace(/[\[\](){}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (
    normalized === '' ||
    normalized === 'unknown' ||
    normalized === 'unknown artist' ||
    normalized === 'unknown album' ||
    normalized === 'unknown title'
  );
}

function hasUsableValue(value: string | undefined): value is string {
  return !isUnknownLike(value);
}

function chooseValue(
  current: string | undefined,
  fromLookup: string | undefined,
  fromFilename: string | undefined,
): string | undefined {
  if (hasUsableValue(current)) return current;
  if (hasUsableValue(fromLookup)) return fromLookup;
  if (hasUsableValue(fromFilename)) return fromFilename;
  return undefined;
}

function extractAlbumName(directory: string): string | undefined {
  const segments = splitPathSegments(directory);
  return cleanToken(segments[segments.length - 1] ?? '');
}

export function inferMetadataFromPath(filename: string, directory: string): ParsedMetadata {
  const localName = cleanToken(basename(splitPathSegments(filename).join('/')));
  const fileNoExt = localName.replace(/\.[^/.]+$/, '').trim();
  const parts = fileNoExt
    .split(/\s+-\s+/)
    .map(cleanToken)
    .filter(Boolean);
  const parsed: ParsedMetadata = {};

  if (parts.length >= 4 && /^\d{1,2}$/.test(parts[2] ?? '')) {
    parsed.artist = parts[0];
    parsed.album = parts[1];
    parsed.trackNumber = String(Number(parts[2]));
    parsed.title = parts.slice(3).join(' - ');
  } else if (parts.length >= 3 && /^\d{1,2}$/.test(parts[0] ?? '')) {
    parsed.trackNumber = String(Number(parts[0]));
    parsed.artist = parts[1];
    parsed.title = parts.slice(2).join(' - ');
  } else if (parts.length >= 2 && /^\d{1,2}$/.test(parts[0] ?? '')) {
    parsed.trackNumber = String(Number(parts[0]));
    parsed.title = parts.slice(1).join(' - ');
  } else if (parts.length >= 2) {
    parsed.artist = parts[0];
    parsed.title = parts.slice(1).join(' - ');
  } else if (fileNoExt.length > 0) {
    parsed.title = fileNoExt;
  }

  const folderAlbum = extractAlbumName(directory);
  if (!parsed.album && hasUsableValue(folderAlbum)) {
    parsed.album = folderAlbum;
  }

  return parsed;
}

export class MetadataFixer {
  private musicDir: string;
  private enabled: boolean;
  private minScore: number;
  private fetchFn: typeof fetch;
  private nextLookupAt = 0;

  constructor(options: MetadataFixerOptions) {
    this.musicDir = this.expandDir(options.musicDir);
    this.enabled = options.enabled ?? true;
    this.minScore = options.minScore ?? 85;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async fixFileAtAbsolutePath(
    absolutePath: string,
    hint: ParsedMetadata,
  ): Promise<{ fixed: boolean; changes: Partial<ParsedMetadata> }> {
    const empty = { fixed: false, changes: {} };
    if (!this.enabled) return empty;

    const ext = extname(absolutePath).toLowerCase();
    if (ext === '.mp3') return this.fixMp3AtPath(absolutePath, hint);
    if (ext === '.flac' || ext === '.ogg' || ext === '.opus') return this.fixVorbisAtPath(absolutePath, hint);
    return empty;
  }

  async processCompletedDownloads(files: CompletedDownloadFile[]): Promise<void> {
    if (!this.enabled || files.length === 0) return;

    for (const file of files) {
      await this.fixSingleFile(file);
    }
  }

  async reprocessLibrary(
    onProgress?: (stats: ReprocessStats) => void,
  ): Promise<ReprocessStats> {
    const stats: ReprocessStats = { processed: 0, total: 0, fixed: 0, skipped: 0, errors: 0 };
    if (!this.enabled) return stats;

    const files = [...walkAudioFiles(this.musicDir)];
    stats.total = files.length;
    log.info({ total: files.length }, 'Starting library metadata reprocess');
    onProgress?.(stats);

    for (const filePath of files) {
      try {
        const result = await this.fixByReadingExistingTags(filePath);
        if (result.fixed) stats.fixed++;
        else stats.skipped++;
      } catch (err) {
        log.warn({ err, filePath }, 'Error reprocessing file');
        stats.errors++;
      }
      stats.processed++;
      onProgress?.(stats);
    }

    return stats;
  }

  async organizeLibrary(
    options: { dryRun?: boolean; fixMetadataFirst?: boolean },
    onProgress?: (stats: OrganizeStats) => void,
  ): Promise<OrganizeStats> {
    const dryRun = options.dryRun ?? true;
    const stats: OrganizeStats = {
      processed: 0, total: 0, fixed: 0, skipped: 0, errors: 0,
      renamed: 0, dryRun, changes: [],
    };

    const files = [...walkAudioFiles(this.musicDir)];
    stats.total = files.length;
    log.info({ total: files.length, dryRun }, 'Starting library organize');
    onProgress?.(stats);

    for (const filePath of files) {
      try {
        if (options.fixMetadataFirst && this.enabled) {
          await this.fixByReadingExistingTags(filePath);
        }

        const meta = await this.readCurrentMetadata(filePath);
        if (!hasUsableValue(meta.title)) {
          stats.skipped++;
          stats.processed++;
          onProgress?.(stats);
          continue;
        }

        const ext = extname(filePath).toLowerCase();
        const targetPath = buildCanonicalPath(this.musicDir, meta, ext);

        if (filePath === targetPath) {
          stats.skipped++;
          stats.processed++;
          onProgress?.(stats);
          continue;
        }

        const resolvedTarget = this.resolveCollision(targetPath, filePath);
        const change: OrganizeChange = {
          from: relative(this.musicDir, filePath).replace(/\\/g, '/'),
          to: relative(this.musicDir, resolvedTarget).replace(/\\/g, '/'),
          reason: 'renamed',
        };

        if (!dryRun) {
          mkdirSync(dirname(resolvedTarget), { recursive: true });
          renameSync(filePath, resolvedTarget);
          log.info({ from: filePath, to: resolvedTarget }, 'Organized file');
        }
        stats.renamed++;
        stats.fixed++;
        stats.changes.push(change);
      } catch (err) {
        log.warn({ err, filePath }, 'Error organizing file');
        stats.errors++;
      }
      stats.processed++;
      onProgress?.(stats);
    }

    return stats;
  }

  private async readCurrentMetadata(absolutePath: string): Promise<ParsedMetadata> {
    const ext = extname(absolutePath).toLowerCase();
    let meta: ParsedMetadata = {};

    if (ext === '.mp3') {
      const nodeId3 = await getNodeId3();
      if (nodeId3) {
        const raw = nodeId3.read(absolutePath);
        const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
        meta = {
          title: asString(data.title),
          artist: asString(data.artist),
          album: asString(data.album),
          trackNumber: asString(data.trackNumber),
        };
      }
    } else if (ext === '.flac' || ext === '.ogg' || ext === '.opus') {
      const mm = await getMusicMetadata();
      if (mm) {
        try {
          const parsed = await mm.parseFile(absolutePath, { duration: false });
          meta = {
            title: parsed.common.title,
            artist: parsed.common.artist,
            album: parsed.common.album,
            trackNumber: parsed.common.track?.no ? String(parsed.common.track.no) : undefined,
          };
        } catch { /* fall through to inference */ }
      }
    }

    const inferred = inferMetadataFromPath(absolutePath, absolutePath);
    return {
      title: hasUsableValue(meta.title) ? meta.title : inferred.title,
      artist: hasUsableValue(meta.artist) ? meta.artist : inferred.artist,
      album: hasUsableValue(meta.album) ? meta.album : inferred.album,
      trackNumber: meta.trackNumber ?? inferred.trackNumber,
    };
  }

  private resolveCollision(targetPath: string, sourcePath: string): string {
    if (!existsSync(targetPath) || targetPath === sourcePath) return targetPath;
    const ext = extname(targetPath);
    const base = targetPath.slice(0, -ext.length);
    for (let i = 2; i <= 99; i++) {
      const candidate = `${base} (${i})${ext}`;
      if (!existsSync(candidate)) return candidate;
    }
    return targetPath;
  }

  private async fixByReadingExistingTags(absolutePath: string): Promise<{ fixed: boolean }> {
    const ext = extname(absolutePath).toLowerCase();
    const empty = { fixed: false };

    if (ext === '.mp3') {
      const nodeId3 = await getNodeId3();
      if (!nodeId3) return empty;
      const raw = nodeId3.read(absolutePath);
      const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      const hint: ParsedMetadata = {
        title: asString(data.title),
        artist: asString(data.artist),
        album: asString(data.album),
        trackNumber: asString(data.trackNumber),
      };
      const result = await this.fixMp3AtPath(absolutePath, hint);
      return { fixed: result.fixed };
    }

    if (ext === '.flac' || ext === '.ogg' || ext === '.opus') {
      const mm = await getMusicMetadata();
      if (!mm) return empty;
      let hint: ParsedMetadata = {};
      try {
        const parsed = await mm.parseFile(absolutePath, { duration: false });
        hint = {
          title: parsed.common.title,
          artist: parsed.common.artist,
          album: parsed.common.album,
          trackNumber: parsed.common.track?.no ? String(parsed.common.track.no) : undefined,
        };
      } catch {
        hint = inferMetadataFromPath(absolutePath, absolutePath);
      }
      const result = await this.fixVorbisAtPath(absolutePath, hint);
      return { fixed: result.fixed };
    }

    return empty;
  }

  private async fixMp3AtPath(
    absolutePath: string,
    hint: ParsedMetadata,
  ): Promise<{ fixed: boolean; changes: Partial<ParsedMetadata> }> {
    const empty = { fixed: false, changes: {} };
    const nodeId3 = await getNodeId3();
    if (!nodeId3) return empty;

    const existingRaw = nodeId3.read(absolutePath);
    const existingData =
      existingRaw && typeof existingRaw === 'object'
        ? (existingRaw as Record<string, unknown>)
        : {};
    const existing: ParsedMetadata = {
      title: asString(existingData.title),
      artist: asString(existingData.artist),
      album: asString(existingData.album),
      trackNumber: asString(existingData.trackNumber),
    };

    const inferred = inferMetadataFromPath(absolutePath, absolutePath);
    const query: ParsedMetadata = {
      title: hint.title ?? existing.title ?? inferred.title,
      artist: hint.artist ?? existing.artist ?? inferred.artist,
      album: hint.album ?? existing.album ?? inferred.album,
    };

    if (!hasUsableValue(query.title)) return empty;

    const lookedUp = await this.lookupMusicBrainz(query);
    if (!lookedUp) return empty;

    const target: ParsedMetadata = {
      title: chooseValue(lookedUp.title, hint.title, existing.title),
      artist: chooseValue(lookedUp.artist, hint.artist, existing.artist),
      album: chooseValue(lookedUp.album, hint.album, existing.album),
      trackNumber: asString(existing.trackNumber) ?? hint.trackNumber,
    };

    const changes: Partial<ParsedMetadata> = {};
    if (target.title && target.title !== existing.title) changes.title = target.title;
    if (target.artist && target.artist !== existing.artist) changes.artist = target.artist;
    if (target.album && target.album !== existing.album) changes.album = target.album;

    if (Object.keys(changes).length === 0) return empty;

    const update: Record<string, string> = {};
    if (changes.title) update.title = changes.title;
    if (changes.artist) update.artist = changes.artist;
    if (changes.album) update.album = changes.album;
    if (target.trackNumber) update.trackNumber = target.trackNumber;

    try {
      const ok = nodeId3.update(update, absolutePath);
      if (!ok) {
        log.warn({ absolutePath }, 'Failed to write ID3 tags');
        return empty;
      }
      log.info({ absolutePath, changes }, 'Repaired MP3 metadata');
      return { fixed: true, changes };
    } catch (err) {
      log.warn({ err, absolutePath }, 'Failed to repair MP3 metadata');
      return empty;
    }
  }

  private async fixVorbisAtPath(
    absolutePath: string,
    hint: ParsedMetadata,
  ): Promise<{ fixed: boolean; changes: Partial<ParsedMetadata> }> {
    const empty = { fixed: false, changes: {} };
    const mm = await getMusicMetadata();
    if (!mm) return empty;

    let existing: ParsedMetadata = {};
    try {
      const parsed = await mm.parseFile(absolutePath, { duration: false });
      existing = {
        title: parsed.common.title,
        artist: parsed.common.artist,
        album: parsed.common.album,
        trackNumber: parsed.common.track?.no ? String(parsed.common.track.no) : undefined,
      };
    } catch {
      existing = inferMetadataFromPath(absolutePath, absolutePath);
    }

    const inferred = inferMetadataFromPath(absolutePath, absolutePath);
    const query: ParsedMetadata = {
      title: hint.title ?? existing.title ?? inferred.title,
      artist: hint.artist ?? existing.artist ?? inferred.artist,
      album: hint.album ?? existing.album ?? inferred.album,
    };

    if (!hasUsableValue(query.title)) return empty;

    const lookedUp = await this.lookupMusicBrainz(query);
    if (!lookedUp) return empty;

    const target: ParsedMetadata = {
      title: chooseValue(lookedUp.title, hint.title, existing.title),
      artist: chooseValue(lookedUp.artist, hint.artist, existing.artist),
      album: chooseValue(lookedUp.album, hint.album, existing.album),
      trackNumber: existing.trackNumber ?? hint.trackNumber,
    };

    const changes: Partial<ParsedMetadata> = {};
    if (target.title && target.title !== existing.title) changes.title = target.title;
    if (target.artist && target.artist !== existing.artist) changes.artist = target.artist;
    if (target.album && target.album !== existing.album) changes.album = target.album;

    if (Object.keys(changes).length === 0) return empty;

    const success = await this.writeFfmpegTags(absolutePath, { ...existing, ...changes });
    if (!success) return empty;

    log.info({ absolutePath, changes }, 'Repaired FLAC/Vorbis metadata');
    return { fixed: true, changes };
  }

  private async writeFfmpegTags(filePath: string, tags: ParsedMetadata): Promise<boolean> {
    const tmpPath = filePath + '.nicotind.tmp';

    const metaArgs: string[] = [];
    if (tags.title) metaArgs.push('-metadata', `TITLE=${tags.title}`);
    if (tags.artist) metaArgs.push('-metadata', `ARTIST=${tags.artist}`);
    if (tags.album) metaArgs.push('-metadata', `ALBUM=${tags.album}`);
    if (tags.trackNumber) metaArgs.push('-metadata', `TRACKNUMBER=${tags.trackNumber}`);

    const args = ['-y', '-i', filePath, '-map_metadata', '0', ...metaArgs, '-c', 'copy', tmpPath];

    return new Promise<boolean>((resolve) => {
      const proc = spawn('ffmpeg', args, { stdio: 'ignore' });
      proc.on('error', () => {
        try { unlinkSync(tmpPath); } catch {}
        resolve(false);
      });
      proc.on('close', (code) => {
        if (code === 0) {
          try {
            renameSync(tmpPath, filePath);
            resolve(true);
          } catch {
            try { unlinkSync(tmpPath); } catch {}
            resolve(false);
          }
        } else {
          try { unlinkSync(tmpPath); } catch {}
          resolve(false);
        }
      });
    });
  }

  private async fixSingleFile(file: CompletedDownloadFile): Promise<void> {
    const fullPath = this.resolveLocalPath(file.directory, file.filename);
    if (!fullPath) {
      log.debug(
        { directory: file.directory, filename: file.filename },
        'Downloaded file not found yet',
      );
      return;
    }

    const ext = extname(fullPath).toLowerCase();

    if (ext === '.mp3') {
      await this.fixNewMp3File(fullPath, file);
    } else if (ext === '.flac' || ext === '.ogg' || ext === '.opus') {
      await this.fixNewVorbisFile(fullPath, file);
    }
  }

  private async fixNewMp3File(fullPath: string, file: CompletedDownloadFile): Promise<void> {
    const nodeId3 = await getNodeId3();
    if (!nodeId3) return;

    const existingRaw = nodeId3.read(fullPath);
    const existingData =
      existingRaw && typeof existingRaw === 'object'
        ? (existingRaw as Record<string, unknown>)
        : {};
    const existing: ParsedMetadata = {
      title: asString(existingData.title),
      artist: asString(existingData.artist),
      album: asString(existingData.album),
      trackNumber: asString(existingData.trackNumber),
    };

    if (!hasUsableValue(existing.title) || !hasUsableValue(existing.artist) || !hasUsableValue(existing.album)) {
      const inferred = inferMetadataFromPath(file.filename, file.directory);
      const lookedUp = await this.lookupMusicBrainz(inferred);

      const target: ParsedMetadata = {
        title: chooseValue(existing.title, lookedUp?.title, inferred.title),
        artist: chooseValue(existing.artist, lookedUp?.artist, inferred.artist),
        album: chooseValue(existing.album, lookedUp?.album, inferred.album),
        trackNumber: asString(existing.trackNumber) ?? inferred.trackNumber,
      };

      const shouldUpdate =
        target.title !== existing.title ||
        target.artist !== existing.artist ||
        target.album !== existing.album ||
        target.trackNumber !== existing.trackNumber;

      if (!shouldUpdate) return;

      const update: Record<string, string> = {};
      if (target.title) update.title = target.title;
      if (target.artist) update.artist = target.artist;
      if (target.album) update.album = target.album;
      if (target.trackNumber) update.trackNumber = target.trackNumber;

      if (Object.keys(update).length === 0) return;

      try {
        const ok = nodeId3.update(update, fullPath);
        if (ok) log.info({ fullPath, update }, 'Repaired MP3 metadata on download');
        else log.warn({ fullPath }, 'Failed to write ID3 tags');
      } catch (err) {
        log.warn({ err, fullPath }, 'Failed to repair MP3 metadata');
      }
    }
  }

  private async fixNewVorbisFile(fullPath: string, file: CompletedDownloadFile): Promise<void> {
    const mm = await getMusicMetadata();
    if (!mm) return;

    let existing: ParsedMetadata = {};
    try {
      const parsed = await mm.parseFile(fullPath, { duration: false });
      existing = {
        title: parsed.common.title,
        artist: parsed.common.artist,
        album: parsed.common.album,
        trackNumber: parsed.common.track?.no ? String(parsed.common.track.no) : undefined,
      };
    } catch {
      return;
    }

    if (!hasUsableValue(existing.title) || !hasUsableValue(existing.artist) || !hasUsableValue(existing.album)) {
      const inferred = inferMetadataFromPath(file.filename, file.directory);
      const lookedUp = await this.lookupMusicBrainz(inferred);

      const target: ParsedMetadata = {
        title: chooseValue(existing.title, lookedUp?.title, inferred.title),
        artist: chooseValue(existing.artist, lookedUp?.artist, inferred.artist),
        album: chooseValue(existing.album, lookedUp?.album, inferred.album),
        trackNumber: existing.trackNumber ?? inferred.trackNumber,
      };

      const shouldUpdate =
        target.title !== existing.title ||
        target.artist !== existing.artist ||
        target.album !== existing.album;

      if (!shouldUpdate) return;

      const changes: Partial<ParsedMetadata> = {};
      if (target.title && target.title !== existing.title) changes.title = target.title;
      if (target.artist && target.artist !== existing.artist) changes.artist = target.artist;
      if (target.album && target.album !== existing.album) changes.album = target.album;

      if (Object.keys(changes).length === 0) return;

      const ok = await this.writeFfmpegTags(fullPath, { ...existing, ...changes });
      if (ok) log.info({ fullPath, changes }, 'Repaired FLAC/Vorbis metadata on download');
      else log.warn({ fullPath }, 'Failed to write FLAC/Vorbis tags');
    }
  }

  private async lookupMusicBrainz(parsed: ParsedMetadata): Promise<ParsedMetadata | null> {
    if (!hasUsableValue(parsed.title)) return null;

    const queryParts = [`recording:"${parsed.title.replace(/"/g, '')}"`];
    if (hasUsableValue(parsed.artist))
      queryParts.push(`artist:"${parsed.artist.replace(/"/g, '')}"`);
    if (hasUsableValue(parsed.album))
      queryParts.push(`release:"${parsed.album.replace(/"/g, '')}"`);

    const query = queryParts.join(' AND ');
    const waitMs = this.nextLookupAt - Date.now();
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    this.nextLookupAt = Date.now() + 1100;

    try {
      const url = `https://musicbrainz.org/ws/2/recording?fmt=json&limit=5&query=${encodeURIComponent(query)}`;
      const res = await this.fetchFn(url, {
        headers: {
          'User-Agent': 'NicotinD/0.1 (metadata-fix)',
        },
      });

      if (!res.ok) {
        log.debug({ status: res.status, query }, 'MusicBrainz lookup failed');
        return null;
      }

      const body = (await res.json()) as MusicBrainzResponse;
      const recordings = body.recordings ?? [];
      const best = recordings
        .map((item) => ({
          item,
          score: typeof item.score === 'string' ? Number(item.score) : (item.score ?? 0),
        }))
        .sort((a, b) => b.score - a.score)
        .find(({ score }) => score >= this.minScore);

      if (!best) return null;

      const artist = best.item['artist-credit']
        ?.map((credit) => cleanToken(credit.name ?? credit.artist?.name ?? ''))
        .filter(Boolean)
        .join(', ');

      const album = cleanToken(best.item.releases?.[0]?.title ?? '');
      const title = cleanToken(best.item.title ?? '');

      return {
        title: title || undefined,
        artist: artist || undefined,
        album: album || undefined,
      };
    } catch (err) {
      log.debug({ err, query }, 'MusicBrainz lookup error');
      return null;
    }
  }

  private resolveLocalPath(directory: string, filename: string): string | null {
    const filenameSegments = splitPathSegments(filename);
    const directorySegments = splitPathSegments(directory);

    const resolvedFromFilename = join(this.musicDir, ...filenameSegments);
    const baseName = filenameSegments[filenameSegments.length - 1] ?? filename;

    const candidates = [
      resolvedFromFilename,
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
