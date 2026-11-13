/** Shape of `manifest.json`, the pinned file list the demo build fetches. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ManifestTrack {
  /** File name inside the Archive item. */
  file: string;
  sha1: string;
  size: number;
  title: string;
  /** 1-based, renumbered after `exclude`/`maxTracks`. */
  track: number;
  seconds: number;
}

export interface ManifestAlbum {
  ia: string;
  artist: string;
  title: string;
  year: number | null;
  genre: string;
  heldBack: boolean;
  licence: string;
  sourceUrl: string;
  cover: { file: string; sha1: string; size: number } | null;
  tracks: ManifestTrack[];
}

export interface DemoManifest {
  version: 1;
  albums: ManifestAlbum[];
}

export const MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), 'manifest.json');

export function loadManifest(path = MANIFEST_PATH): DemoManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as DemoManifest;
}

export function iaFileUrl(ia: string, file: string): string {
  return `https://archive.org/download/${encodeURIComponent(ia)}/${file.split('/').map(encodeURIComponent).join('/')}`;
}
