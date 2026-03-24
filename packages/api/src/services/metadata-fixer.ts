import { existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { createLogger } from '@nicotind/core';

const log = createLogger('metadata-fixer');

export interface CompletedDownloadFile {
  username: string;
  directory: string;
  filename: string;
}

export interface ParsedMetadata {
  title?: string;
  artist?: string;
  album?: string;
  trackNumber?: string;
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
            'node-id3 is not installed, metadata repair is disabled until dependencies are installed',
          );
        }
        return null;
      });
  }
  return nodeId3Promise;
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

    const nodeId3 = await getNodeId3();
    if (!nodeId3) return empty;

    if (extname(absolutePath).toLowerCase() !== '.mp3') return empty;

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

    // Force mode: always query MusicBrainz using Navidrome hint as the query seed.
    // Fall back to existing tags, then filename inference for missing hint fields.
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
        log.warn({ absolutePath }, 'Failed to write ID3 tags (on-demand fix)');
        return empty;
      }
      log.info({ absolutePath, changes }, 'Repaired audio metadata (on-demand)');
      return { fixed: true, changes };
    } catch (err) {
      log.warn({ err, absolutePath }, 'Failed to repair audio metadata (on-demand)');
      return empty;
    }
  }

  async processCompletedDownloads(files: CompletedDownloadFile[]): Promise<void> {
    if (!this.enabled || files.length === 0) return;

    for (const file of files) {
      await this.fixSingleFile(file);
    }
  }

  private async fixSingleFile(file: CompletedDownloadFile): Promise<void> {
    const nodeId3 = await getNodeId3();
    if (!nodeId3) {
      return;
    }

    const fullPath = this.resolveLocalPath(file.directory, file.filename);
    if (!fullPath) {
      log.debug(
        { directory: file.directory, filename: file.filename },
        'Downloaded file not found yet',
      );
      return;
    }

    if (extname(fullPath).toLowerCase() !== '.mp3') {
      return;
    }

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

    const needsTitle = !hasUsableValue(existing.title);
    const needsArtist = !hasUsableValue(existing.artist);
    const needsAlbum = !hasUsableValue(existing.album);

    if (!needsTitle && !needsArtist && !needsAlbum) {
      return;
    }

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

    if (!shouldUpdate) {
      return;
    }

    const update: Record<string, string> = {};
    if (target.title) update.title = target.title;
    if (target.artist) update.artist = target.artist;
    if (target.album) update.album = target.album;
    if (target.trackNumber) update.trackNumber = target.trackNumber;

    if (Object.keys(update).length === 0) {
      return;
    }

    try {
      const ok = nodeId3.update(update, fullPath);
      if (!ok) {
        log.warn({ fullPath }, 'Failed to write ID3 tags');
        return;
      }
      log.info({ fullPath, update }, 'Repaired audio metadata');
    } catch (err) {
      log.warn({ err, fullPath }, 'Failed to repair audio metadata');
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
