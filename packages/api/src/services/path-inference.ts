import { basename } from 'node:path';
import { cleanFolderName } from '@nicotind/core';

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

  const folderAlbum = leafFolderName(directory);
  if (!parsed.album && hasUsableValue(folderAlbum)) {
    parsed.album = folderAlbum;
  }

  return parsed;
}
