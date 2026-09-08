import { normalizeTitle, titlesOverlap } from '@nicotind/core';

// Lossless formats beat any lossy file when choosing the single best copy of a
// track; within a tier, higher bitrate wins. Soulseek rips routinely leave a
// folder with flac + mp3 + m4a (+ wav) copies of the same songs, so "best" here
// is what the library should surface. Also the set the post-download Opus
// transcode targets (lossless → Opus; lossy left untouched).
export const LOSSLESS = new Set(['flac', 'wav', 'wave', 'aiff', 'aif', 'alac', 'ape', 'wv']);

/** Whether a file suffix/extension is a lossless format. Accepts ".flac" or "flac". */
export function isLossless(suffix: string | null | undefined): boolean {
  return LOSSLESS.has((suffix ?? '').toLowerCase().replace(/^\./, ''));
}

/**
 * SQL predicate matching the LOSSLESS set against a suffix column, derived from
 * the same Set so the TS check and any SQL scan cannot drift (the
 * `unresolvedGenreSql` pattern).
 */
export function losslessSuffixSql(col: string): string {
  const list = [...LOSSLESS].map((s) => `'${s}'`).join(', ');
  return `LOWER(COALESCE(${col}, '')) IN (${list})`;
}

/** Quality score for picking the best file among copies of one track. */
export function formatQuality(
  suffix: string | null | undefined,
  bitRate: number | null | undefined,
): number {
  const losslessBonus = LOSSLESS.has((suffix ?? '').toLowerCase()) ? 10_000_000 : 0;
  return losslessBonus + (bitRate ?? 0);
}

export interface SelectableTrack {
  /** Stable identity + tiebreak; also what callers map back to the full row. */
  relPath: string;
  /** Resolved display title (post tag/path inference). */
  title: string;
  suffix: string;
  bitRate: number;
  /** Disc number from tags. Absent/null means "the only disc" (issue #747). */
  disc?: number | null;
}

/**
 * Reduce one album's files to a clean, consumable tracklist: **one best-quality
 * file per track**.
 *
 * - **With a canonical (Lidarr) tracklist** — each file is keyed to the canonical
 *   track it matches (diacritic-insensitive, fuzzy via `titlesOverlap`), so the
 *   same song ripped at different track numbers/formats collapses to one entry.
 *   A file matching **no** canonical track keys by its own title and is **kept**:
 *   the tracklist ranks duplicate files of a track, it never deletes the only
 *   copy of one (issue #968). It used to drop them as foreign, which deleted
 *   real music whenever the pinned list described a different edition than the
 *   files that landed — a remaster, a regional release, or a title differing
 *   only in punctuation. That cost 121 unreachable tracks on prod, and the
 *   drop was a ratchet: `knownRelPaths` is read from `library_songs`, so a
 *   dropped file never becomes known and is re-dropped by every later scan.
 *   The cost of retention is that a genuinely foreign rip in a mixed folder now
 *   surfaces in the album — curation's job, not the scanner's, because the two
 *   are indistinguishable by title (on prod, 133 of 134 such files carried the
 *   album's own artist tag).
 * - `knownRelPaths` (files the library already holds) additionally bypasses
 *   canonical keying entirely, so a curator's title correction is never re-keyed
 *   to the canonical wording it deliberately moved away from (issue #776).
 * - **Without one** — files are keyed by normalized title, so format-duplicates
 *   of the same song still collapse to the best copy, but nothing is dropped as
 *   "foreign" (we have no authority on what belongs).
 *
 * Pure and deterministic: ties break on the lexicographically smallest relPath
 * so repeated scans always keep the same file. Returns the kept tracks.
 */
export function selectAlbumTracks<T extends SelectableTrack>(
  tracks: T[],
  canonicalTitles?: readonly string[] | null,
  knownRelPaths?: ReadonlySet<string>,
): T[] {
  return selectAlbumTracksDetailed(tracks, canonicalTitles, knownRelPaths).kept;
}

/**
 * {@link selectAlbumTracks} plus **which keeper each dropped track lost to**.
 *
 * why: a caller that deletes the losers needs to be able to say what survived in
 * their place. Without it, an acquisition whose file was collapsed into an
 * existing copy points at a path that no longer exists and can never resolve
 * (issue #1032). The keeper selection is identical — this returns the same
 * `kept` set, just without discarding the grouping that produced it.
 */
export function selectAlbumTracksDetailed<T extends SelectableTrack>(
  tracks: T[],
  canonicalTitles?: readonly string[] | null,
  knownRelPaths?: ReadonlySet<string>,
): { kept: T[]; supersededBy: Map<T, T> } {
  const canon = (canonicalTitles ?? []).map((c) => normalizeTitle(c)).filter((c) => c.length > 0);
  const useCanonical = canon.length > 0;

  const best = new Map<string, T>();
  const groups = new Map<string, T[]>();
  for (const t of tracks) {
    const norm = normalizeTitle(t.title);
    // A track's identity within an album is (disc, title), not title. Album
    // identity deliberately collapses discs, so without this term a title that
    // legitimately repeats across discs loses one real file (issue #747).
    // Untagged means "the only disc", which keeps single-disc albums — every
    // track keyed `1` — behaving exactly as before.
    const disc = t.disc ?? 1;

    // One keyspace on purpose: a file keyed by the canonical track it matched and
    // a file keyed by its own identical title are the same track, so they collapse
    // to the best copy instead of both surviving as separate rows.
    // A file the tracklist does not name keys by its own title rather than being
    // dropped — the list ranks duplicate files of a track, it never deletes the
    // only copy of one (#968).
    const key = `${disc}:${
      useCanonical && !knownRelPaths?.has(t.relPath)
        ? (canon.find((c) => titlesOverlap(c, norm)) ?? norm)
        : norm
    }`;

    groups.set(key, [...(groups.get(key) ?? []), t]);

    const cur = best.get(key);
    if (!cur) {
      best.set(key, t);
      continue;
    }
    const q = formatQuality(t.suffix, t.bitRate);
    const cq = formatQuality(cur.suffix, cur.bitRate);
    if (q > cq || (q === cq && t.relPath < cur.relPath)) best.set(key, t);
  }

  const supersededBy = new Map<T, T>();
  for (const [key, members] of groups) {
    const winner = best.get(key)!;
    for (const m of members) if (m !== winner) supersededBy.set(m, winner);
  }

  return { kept: [...best.values()], supersededBy };
}
