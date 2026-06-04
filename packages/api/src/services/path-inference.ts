import { basename } from 'node:path';
import { cleanFolderName } from '@nicotind/core';
import { looksLikeFilenameTag } from './path-sanitize.js';

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

function splitPathSegments(input: string): string[] {
  return input.split(/[\\/]+/).filter(Boolean);
}

function cleanToken(input: string): string {
  return input.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
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

export function hasUsableValue(value: string | undefined): value is string {
  return !isUnknownLike(value);
}

function leafFolderName(directory: string): string | undefined {
  const segments = splitPathSegments(directory);
  return cleanToken(segments[segments.length - 1] ?? '');
}

/**
 * Returns the album name to write for a folder, optionally stripping a
 * leading `"<artist> - "` prefix. Used by the single-artist consolidation
 * path so that `"Daft Punk - Discovery"` + artist `"Daft Punk"` resolves
 * to `"Discovery"`, while `"Nomads"` + artist `"Nomads"` stays `"Nomads"`.
 */
export function extractAlbumName(folderName: string, artist: string | undefined): string {
  const cleaned = cleanFolderName(folderName);
  if (!artist) return cleaned;
  const prefix = `${artist} - `;
  if (cleaned.toLowerCase().startsWith(prefix.toLowerCase())) {
    const tail = cleaned.slice(prefix.length).trim();
    if (tail.length > 0) return tail;
  }
  return cleaned;
}

/**
 * Folder names that are generic/technical and should not be used as album names.
 * Soulseek peers frequently organize under "music/", "downloads/", etc.
 */
const GENERIC_FOLDER_NAMES = new Set([
  'src',
  'source',
  'downloads',
  'download',
  'music',
  'audio',
  'mp3',
  'flac',
  'wav',
  'm4a',
  'ogg',
  'aac',
  'misc',
  'mixed',
  'files',
  'shared',
  'uploads',
  'media',
  'new',
  'old',
  'temp',
  'tmp',
  'data',
  'unsorted',
]);

function looksLikeGenericFolder(folderName: string): boolean {
  const lower = folderName.toLowerCase().trim();
  if (lower.length <= 2) return true;
  if (GENERIC_FOLDER_NAMES.has(lower)) return true;
  // Pure numbers ≤3 digits (track/disc counts like "01", "1", "CD1")
  if (/^(cd|disc|disk)?\s*\d{1,2}$/i.test(lower)) return true;
  return false;
}

/**
 * Derives an album name from a peer-side directory path.
 * Returns undefined when the folder is generic, looks like a filename,
 * or would just echo the artist name.
 */
export function inferFolderAlbum(
  directory: string,
  artist: string | undefined,
): string | undefined {
  const leaf = leafFolderName(directory);
  if (
    !leaf ||
    !hasUsableValue(leaf) ||
    looksLikeFilenameTag(leaf) ||
    looksLikeGenericFolder(leaf)
  ) {
    return undefined;
  }
  const album = extractAlbumName(leaf, artist);
  if (!album) return undefined;
  // Don't use the folder name as album if it's the same as the artist (artist-named folder).
  if (
    artist &&
    album.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '') ===
      artist.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  ) {
    return undefined;
  }
  return album;
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

  // Permissive track-prefix strip on the inferred title: handles "01-Demasiado",
  // "5 Track" (cleanToken turns underscores into spaces), "06 its always you".
  // \d{1,3} keeps 4-digit years like "1989" safe.
  if (parsed.title) {
    const m = parsed.title.match(/^\s*(\d{1,3})\s*(?:[.)\-_]\s*|\s+)(\S.*)$/);
    if (m) {
      if (!parsed.trackNumber) parsed.trackNumber = String(Number(m[1]));
      parsed.title = m[2];
    }
  }

  const folderAlbum = leafFolderName(directory);
  if (!parsed.album && hasUsableValue(folderAlbum) && !looksLikeFilenameTag(folderAlbum)) {
    parsed.album = folderAlbum;
  }

  return parsed;
}
