import type { Database } from 'bun:sqlite';
import { isSinglesBucketDir } from './library-scanner.js';

/**
 * Does a cover image sitting next to a track belong to that track's album?
 *
 * Folder art is only meaningful when the directory *is* one album's folder, and
 * some directories are **shared buckets** holding unrelated tracks the scanner
 * splits into one single-album each (`isLooseSinglesBucket`). Every reader of
 * folder art has to ask this before trusting `dirname(track)` — the writer side
 * has always known which directories are buckets, and issue #978 was that
 * knowledge never reaching the readers: one `cover.jpg` a download dropped into
 * `Various Artists/Unknown/` became the cover of 1,229 unrelated albums.
 *
 * Two independent checks, because neither subsumes the other:
 *
 *  - **The name.** A `<Artist>/Singles/` folder is a bucket by construction even
 *    while it happens to hold one track, so the count below cannot yet see it.
 *    Free (no query), and it keeps reader and writer using one definition.
 *  - **The contents.** A bucket nobody named — `Various Artists/Unknown/` is the
 *    live one — is only visible structurally: more than one album's tracks in
 *    one directory means the directory is not an album folder.
 *
 * A directory the scanner has no rows for is treated as an album folder: an
 * un-scanned file is not evidence of a bucket.
 */
export function folderArtBelongsToAlbum(db: Database, relPath: string): boolean {
  const cut = relPath.lastIndexOf('/');
  const relDir = cut === -1 ? '' : relPath.slice(0, cut);
  if (isSinglesBucketDir(relDir)) return false;
  return countAlbumsInDir(db, relDir) <= 1;
}

/**
 * How many distinct albums have a track directly in `relDir` (not in a
 * sub-directory). Written as a range scan over `idx_library_songs_path` rather
 * than `LIKE 'dir/%'`, which SQLite cannot answer from that index and which
 * would need wildcard escaping for folder names containing `%` or `_`.
 */
function countAlbumsInDir(db: Database, relDir: string): number {
  const prefix = relDir === '' ? '' : `${relDir}/`;
  const depth = prefix.length + 1;
  const row = prefix
    ? db
        .query<{ n: number }, [string, string, number]>(
          `SELECT COUNT(DISTINCT album_id) AS n FROM library_songs
            WHERE path >= ? AND path < ? AND instr(substr(path, ?), '/') = 0`,
        )
        .get(prefix, upperBound(prefix), depth)
    : db
        .query<{ n: number }, [number]>(
          `SELECT COUNT(DISTINCT album_id) AS n FROM library_songs
            WHERE instr(substr(path, ?), '/') = 0`,
        )
        .get(depth);
  return row?.n ?? 0;
}

/** Exclusive upper bound of the `prefix*` key range, for a BINARY-collated index. */
function upperBound(prefix: string): string {
  return prefix.slice(0, -1) + String.fromCodePoint(prefix.codePointAt(prefix.length - 1)! + 1);
}
