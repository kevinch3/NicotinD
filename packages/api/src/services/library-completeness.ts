import type { Database } from 'bun:sqlite';
import { normalizeForGrouping } from './album-grouping.js';
import { normalizeTitle, titlesOverlap } from './album-hunter.service.js';
import { albumIdFor } from './library-scanner.js';

/**
 * True when the library already holds this album (same artist, same
 * edition-stripped title) with at least as many songs as its canonical
 * tracklist. Uses `normalizeForGrouping` so deluxe/remaster editions of an album
 * we already have are treated as "complete" and don't get re-acquired.
 *
 * Shared by the hunt-download route (duplicate-acquisition guard) and the
 * watchlist poller (so a watched album already on disk resolves immediately).
 */
export function albumAlreadyComplete(
  db: Database,
  artist: string,
  title: string,
  trackCount: number,
): boolean {
  const targetName = normalizeForGrouping(title);
  const rows = db
    .query<{ name: string; song_count: number }, [string]>(
      `SELECT name, song_count FROM library_albums WHERE artist = ? COLLATE NOCASE`,
    )
    .all(artist);
  return rows.some((r) => normalizeForGrouping(r.name) === targetName && r.song_count >= trackCount);
}

/** Normalize a peer filename to its bare track title (drops dir, ext, track #). */
function normalizeFileBasename(filename: string): string {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? filename;
  const noExt = base.slice(0, base.lastIndexOf('.') || base.length);
  return normalizeTitle(noExt);
}

/** Normalized titles of songs already in the library on disk for this album. */
function onDiskTitles(db: Database, artist: string, title: string): string[] {
  const albumId = albumIdFor(artist, title);
  const rows = db
    .query<{ title: string }, [string]>('SELECT title FROM library_songs WHERE album_id = ?')
    .all(albumId);
  return rows.map((r) => normalizeTitle(r.title));
}

/**
 * Filter a chosen folder's files down to only those whose track is **not** already
 * present in the library on disk.
 *
 * why: this is the root-cause guard against duplicate album versions. When a user
 * (re-)hunts an album that's *partially* on disk (e.g. 4 of 12 tracks), enqueuing
 * the whole chosen folder re-downloads the 4 we already have — and any rip whose
 * filename differs even slightly (a "(Studio Remix)"/edition suffix, a different
 * track-number style) escapes the post-organize dedupe and lands as a second copy
 * of the track. Downloading only the genuinely-missing tracks ("complete-only")
 * means a partial album fills in cleanly instead of accreting duplicate versions.
 *
 * Keyed on the same deterministic album id the scanner mints, so an existing
 * deluxe/edition folder of the album counts. Returns all files unchanged when the
 * album isn't on disk yet (a fresh hunt downloads everything, as before).
 */
export function filesMissingOnDisk<T extends { filename: string }>(
  db: Database,
  artist: string,
  title: string,
  files: T[],
): T[] {
  const onDisk = onDiskTitles(db, artist, title);
  if (onDisk.length === 0) return files;
  return files.filter((f) => {
    const norm = normalizeFileBasename(f.filename);
    return !onDisk.some((t) => titlesOverlap(t, norm));
  });
}
