import type { Database } from 'bun:sqlite';
import { normalizeForGrouping } from './album-grouping.js';
import { normalizeTitle, titlesOverlap } from '@nicotind/core';
import { albumIdFor, artistIdFor } from './library-scanner.js';

/**
 * Local `library_albums` rows that are "the same album" as `artist`/`title`:
 * same artist *identity* (`artist_id`, which strips diacritics + edition noise via
 * `normalizeArtistForGrouping`) and same edition-stripped title (`normalizeForGrouping`).
 *
 * why: the canonical Lidarr artist/title routinely diverges from how the local row
 * is tagged (accents, `feat.`, edition words, artist-name spelling — routine in this
 * Latin-American-heavy library). Matching on `artist_id` instead of the raw artist
 * string, and on the grouping-normalized title instead of an exact `albumIdFor`,
 * makes a partial album stored under a divergent id still resolve — the root-cause
 * fix for both the duplicate-acquisition guard and the complete-only filter silently
 * finding nothing and re-downloading the whole album.
 */
export function matchingLocalAlbums(
  db: Database,
  artist: string,
  title: string,
): Array<{ id: string; name: string; song_count: number }> {
  const targetName = normalizeForGrouping(title);
  const rows = db
    .query<{ id: string; name: string; song_count: number }, [string]>(
      `SELECT id, name, song_count FROM library_albums WHERE artist_id = ?`,
    )
    .all(artistIdFor(artist));
  return rows.filter((r) => normalizeForGrouping(r.name) === targetName);
}

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
  return matchingLocalAlbums(db, artist, title).some((r) => r.song_count >= trackCount);
}

/** Normalize a peer filename to its bare track title (drops dir, ext, track #). */
function normalizeFileBasename(filename: string): string {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? filename;
  const noExt = base.slice(0, base.lastIndexOf('.') || base.length);
  return normalizeTitle(noExt);
}

/** Normalized titles of the songs in one specific local album id. */
function titlesForAlbumId(db: Database, albumId: string): string[] {
  return db
    .query<{ title: string }, [string]>('SELECT title FROM library_songs WHERE album_id = ?')
    .all(albumId)
    .map((r) => normalizeTitle(r.title));
}

/**
 * Normalized titles of songs already in the library on disk for this album.
 *
 * When the caller knows the exact local album the user is completing (the artist
 * page already resolved it as `localAlbumId`), use it directly — that's the
 * precise answer and is robust to the canonical Lidarr artist/title diverging from
 * how the local rows are tagged (accents, `feat.`, edition words, artist spelling).
 * Otherwise fall back to the exact minted id (works off `library_songs` alone, the
 * original behavior) unioned with every local album whose artist *identity* +
 * edition-stripped title match (`matchingLocalAlbums`), so a partial album under a
 * divergent id/edition still counts — not only an exact `albumIdFor` hit.
 */
export function onDiskTitles(
  db: Database,
  artist: string,
  title: string,
  localAlbumId?: string,
): string[] {
  if (localAlbumId) {
    const titles = titlesForAlbumId(db, localAlbumId);
    if (titles.length > 0) return titles;
  }
  const ids = new Set<string>([albumIdFor(artist, title)]);
  for (const a of matchingLocalAlbums(db, artist, title)) ids.add(a.id);
  return [...ids].flatMap((id) => titlesForAlbumId(db, id));
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
 * Matched via the resolved `localAlbumId` when known, else the edition-collapsing
 * grouping match — so an existing deluxe/edition folder of the album counts.
 * Returns all files unchanged when the album isn't on disk yet (a fresh hunt
 * downloads everything, as before).
 */
export function filesMissingOnDisk<T extends { filename: string }>(
  db: Database,
  artist: string,
  title: string,
  files: T[],
  localAlbumId?: string,
): T[] {
  const onDisk = onDiskTitles(db, artist, title, localAlbumId);
  if (onDisk.length === 0) return files;
  return files.filter((f) => {
    const norm = normalizeFileBasename(f.filename);
    return !onDisk.some((t) => titlesOverlap(t, norm));
  });
}

/**
 * Filter a chosen folder's files down to the ones that belong to the album we
 * asked for, using its canonical tracklist.
 *
 * why: a peer folder is not necessarily one album. Prod hunted Joe Satriani's
 * self-titled 14-track album and the winning folder was the peer's entire
 * `Joe Satriani\` discography — 254 files. All 254 were enqueued and itemised,
 * so the job's tally read "7 of 240 · 233 unavailable" (issue #262) and 227
 * files of other albums were downloaded for nothing.
 *
 * Deliberately conservative: with no canonical tracklist (a direct grab), or
 * when nothing matches it (filenames too divergent to trust the matcher), the
 * files are returned unchanged. The filter can only ever *remove* files that
 * some other file already covers the tracklist without, so it cannot turn a
 * working hunt into an empty one. A canonical track whose filename is too
 * divergent to match is dropped here and recovered by the fallback's
 * fresh-per-track search, the same path that handles any other missing track.
 */
export function filesForCanonicalTracks<T extends { filename: string }>(
  files: T[],
  canonicalTracks: string[],
): T[] {
  if (canonicalTracks.length === 0) return files;
  const matched = files.filter((f) => {
    const norm = normalizeFileBasename(f.filename);
    return canonicalTracks.some((t) => titlesOverlap(normalizeTitle(t), norm));
  });
  return matched.length > 0 ? matched : files;
}
