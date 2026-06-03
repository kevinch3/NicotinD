import { normalizeTitle, titlesOverlap } from './album-hunter.service.js';

// Lossless formats beat any lossy file when choosing the single best copy of a
// track; within a tier, higher bitrate wins. Soulseek rips routinely leave a
// folder with flac + mp3 + m4a (+ wav) copies of the same songs, so "best" here
// is what the library should surface.
const LOSSLESS = new Set(['flac', 'wav', 'wave', 'aiff', 'aif', 'alac', 'ape', 'wv']);

/** Quality score for picking the best file among copies of one track. */
export function formatQuality(suffix: string | null | undefined, bitRate: number | null | undefined): number {
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
): T[] {
  const canon = (canonicalTitles ?? [])
    .map((c) => normalizeTitle(c))
    .filter((c) => c.length > 0);
  const useCanonical = canon.length > 0;

  const best = new Map<string, T>();
  for (const t of tracks) {
    const norm = normalizeTitle(t.title);

    let key: string;
    if (useCanonical) {
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
