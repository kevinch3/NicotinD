import { normalizeTitle } from '@nicotind/core';

/**
 * Deciding whether a stranded download is safe to delete (#1052).
 *
 * The slskd addon kept every file it ever downloaded — 34 GB on kpc. Most of it
 * duplicates tracks already in the library, but "most" is not a licence to
 * delete: a title match alone is **not** proof. Measured on a 60-file sample of
 * the real backlog, matching on title would have deleted "Una vez más" at 235 s
 * against library rows of 180/255/175/241 s — a different recording entirely.
 *
 * So a file is only reclaimable when the library demonstrably holds *this*
 * recording: same title, same duration, and the library's own file still on
 * disk. Anything short of that is left alone for a person to look at.
 */

/** Seconds a transcode may shift a track's duration before we stop believing it is the same one. */
export const DURATION_TOLERANCE_S = 2;

export interface LibraryTrack {
  title: string;
  duration: number;
  /** Path relative to the music dir. */
  path: string;
}

export type ReclaimVerdict =
  | { kind: 'proven'; matched: LibraryTrack }
  | { kind: 'no-title-match' }
  | { kind: 'duration-mismatch'; libraryDurations: number[] }
  | { kind: 'library-file-missing' }
  | { kind: 'unreadable' };

/**
 * Comparison key. `normalizeTitle` is the shared normalizer (accent-folding
 * before the punctuation strip, Unicode-aware), and it already drops a leading
 * track number; the space strip here just makes "Song One"/"SongOne" agree.
 */
export function titleKey(s: string): string {
  return normalizeTitle(s).replace(/\s+/g, '');
}

/**
 * The track title inside a download's filename.
 *
 * Peers name files every way imaginable; the two that actually occur in the
 * backlog are `07 Title` and `Artist - Album - 07 - Title`. Taking the segment
 * after the last ` - ` handles the second and is a no-op on the first, then the
 * leading track number goes.
 */
export function titleFromFilename(basename: string): string {
  const stem = basename.replace(/\.[a-z0-9]+$/i, '');
  const parts = stem.split(/\s+-\s+/);
  const last = parts.length > 1 ? (parts[parts.length - 1] ?? stem) : stem;
  // `normalizeTitle` strips a leading track number; the `)` form it does not
  // cover ("1) Title") is handled here so both shapes reduce alike.
  return last.replace(/^[0-9]{1,3}[\s._)-]*/, '').trim();
}

/** Library rows grouped by title key, ready for repeated lookups. */
export function indexLibrary(tracks: LibraryTrack[]): Map<string, LibraryTrack[]> {
  const index = new Map<string, LibraryTrack[]>();
  for (const t of tracks) {
    const key = titleKey(t.title);
    if (!key) continue;
    const bucket = index.get(key);
    if (bucket) bucket.push(t);
    else index.set(key, [t]);
  }
  return index;
}

/**
 * Is this stranded file provably redundant?
 *
 * `durationS` is the file's measured length, `libraryFileExists` says whether a
 * candidate's own file is still on disk — a library row pointing at a deleted
 * file proves nothing, and deleting the download on its word would lose the
 * only copy.
 */
export function judgeStrandedFile(
  basename: string,
  durationS: number | null,
  library: Map<string, LibraryTrack[]>,
  libraryFileExists: (relPath: string) => boolean,
): ReclaimVerdict {
  if (durationS === null || !Number.isFinite(durationS) || durationS <= 0) {
    return { kind: 'unreadable' };
  }
  const key = titleKey(titleFromFilename(basename));
  // A one- or two-character key ("a", "01") would match half the library.
  if (key.length < 3) return { kind: 'no-title-match' };

  const candidates = library.get(key);
  if (!candidates?.length) return { kind: 'no-title-match' };

  const sameLength = candidates.filter(
    (c) => Math.abs(c.duration - durationS) <= DURATION_TOLERANCE_S,
  );
  if (!sameLength.length) {
    return { kind: 'duration-mismatch', libraryDurations: candidates.map((c) => c.duration) };
  }

  const onDisk = sameLength.find((c) => libraryFileExists(c.path));
  if (!onDisk) return { kind: 'library-file-missing' };

  return { kind: 'proven', matched: onDisk };
}
