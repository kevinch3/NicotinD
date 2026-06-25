/**
 * Derive album group keys from in-flight slskd transfers.
 *
 * The library-listing suppression (`downloadingExclusion` in routes/library.ts)
 * historically keyed only on active `album_jobs`, so a card stayed visible mid-
 * download for any acquisition that didn't create a job row (raw folder-browser
 * grabs, per-track fallbacks). This maps active transfer directories to the same
 * edition-collapsing `albumGroupKey` the suppression uses, so *any* in-flight copy
 * hides its album until the download settles. Pure — unit-testable without slskd.
 */
import type { SlskdUserTransferGroup, SlskdTransferDirectory } from '@nicotind/core';
import { albumGroupKey } from './album-grouping.js';

/** Transfer states that still count as "downloading" (not yet finished/failed). */
const IN_FLIGHT_STATES: ReadonlySet<string> = new Set([
  'Requested',
  'Queued, Locally',
  'Queued, Remotely',
  'Initializing',
  'InProgress',
]);

export function isInFlight(state: string): boolean {
  return IN_FLIGHT_STATES.has(state);
}

/** Last two path segments of a backslash/forward-slash path → {artist, album}. */
function lastTwoSegments(path: string): { artist: string; album: string } | null {
  const segments = path
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);
  if (segments.length < 2) return null;
  return { artist: segments[segments.length - 2]!, album: segments[segments.length - 1]! };
}

/**
 * Parse artist + album for a transfer directory. Prefers the directory path; if
 * that's a single segment, falls back to the first file's full remote path (which
 * carries the `…/Artist/Album/track` structure).
 */
function parseArtistAlbum(dir: SlskdTransferDirectory): { artist: string; album: string } | null {
  const fromDir = lastTwoSegments(dir.directory);
  if (fromDir) return fromDir;
  const fname = dir.files[0]?.filename;
  if (!fname) return null;
  // Drop the filename, keep its parent path, then take the last two segments.
  const parent = fname.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  return lastTwoSegments(parent);
}

/**
 * Group keys for every active transfer directory that still has an in-flight file.
 * Mirrors the download-watcher's directory parsing so the key matches what the
 * album will be filed under once organized.
 */
export function transferGroupKeys(
  groups: SlskdUserTransferGroup[] | undefined | null,
): Set<string> {
  const keys = new Set<string>();
  if (!groups) return keys;
  for (const group of groups) {
    for (const dir of group.directories) {
      if (!dir.files.some((f) => isInFlight(f.state))) continue;
      const parsed = parseArtistAlbum(dir);
      if (!parsed) continue;
      keys.add(albumGroupKey(parsed.artist, parsed.album));
    }
  }
  return keys;
}
