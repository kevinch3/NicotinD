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
}

/**
 * Reduce one album's files to a clean, consumable tracklist: **one best-quality
 * file per track**.
 *
 * - **With a canonical (Lidarr) tracklist** — each file is keyed to the canonical
 *   track it matches (diacritic-insensitive, fuzzy via `titlesOverlap`), so the
 *   same song ripped at different track numbers/formats collapses to one entry,
 *   and any file matching **no** canonical track is **dropped** (foreign /
 *   mislabeled rips that a bad Soulseek folder mixed in — "as Lidarr proposes").
 *   The tracklist decides what to **admit**, never what to **retain**: a file
 *   `knownRelPaths` says the library already holds is keyed by title like the
 *   no-canonical case, so it is never dropped as foreign. Without that, a
 *   curator's title correction removed canonical words, fell under the 0.7
 *   `titlesOverlap` threshold and was discarded from the scan — so the edit
 *   never reached persist and the DB silently kept the old title (issue #776).
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
  const canon = (canonicalTitles ?? []).map((c) => normalizeTitle(c)).filter((c) => c.length > 0);
  const useCanonical = canon.length > 0;

  const best = new Map<string, T>();
  for (const t of tracks) {
    const norm = normalizeTitle(t.title);

    let key: string;
    if (useCanonical && !knownRelPaths?.has(t.relPath)) {
      const match = canon.find((c) => titlesOverlap(c, norm));
      if (!match) continue; // foreign track — not part of the canonical album
      key = `c:${match}`;
    } else {
      key = `t:${norm}`;
    }

    const cur = best.get(key);
    if (!cur) {
      best.set(key, t);
      continue;
    }
    const q = formatQuality(t.suffix, t.bitRate);
    const cq = formatQuality(cur.suffix, cur.bitRate);
    if (q > cq || (q === cq && t.relPath < cur.relPath)) best.set(key, t);
  }

  return [...best.values()];
}
