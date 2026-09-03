/**
 * Disc-aware ordering for an album's tracklist (issue #747).
 *
 * Album identity deliberately collapses every disc into one album row, so on a
 * multi-disc release the position of a track is `(disc, track)` — sorting on
 * `track` alone interleaves the discs and renders two rows both labelled "1".
 *
 * Pure and DOM-free so the ordering can be pinned without a component harness.
 */

/** The only fields ordering needs. Anything with a disc/track shape qualifies. */
export interface DiscPositioned {
  disc?: number;
  track?: number;
}

/** Untagged means "the only disc", never "before every disc". */
const discOf = (s: DiscPositioned): number => s.disc ?? 1;

/**
 * `(disc, track)` ascending, with a missing track last **within its disc** —
 * matching the album route's `ORDER BY COALESCE(s.disc, 1), s.track ASC NULLS
 * LAST`, so client and server cannot disagree about the same list.
 */
export function compareDiscThenTrack(a: DiscPositioned, b: DiscPositioned): number {
  const byDisc = discOf(a) - discOf(b);
  if (byDisc !== 0) return byDisc;
  if (a.track == null && b.track == null) return 0;
  if (a.track == null) return 1;
  if (b.track == null) return -1;
  return a.track - b.track;
}

/**
 * Split a tracklist into per-disc groups, **or return nothing at all** when the
 * album has a single disc. Returning `[]` rather than one group is what keeps
 * disc headers off every ordinary album: the caller renders headers only when
 * this is non-empty, so the common case needs no extra condition at the call
 * site and cannot regress into showing "Disc 1" on a one-disc release.
 */
export function discGroups<T extends DiscPositioned>(
  songs: readonly T[],
): Array<{ disc: number; songs: T[] }> {
  const byDisc = new Map<number, T[]>();
  for (const s of songs) {
    const d = discOf(s);
    const arr = byDisc.get(d);
    if (arr) arr.push(s);
    else byDisc.set(d, [s]);
  }
  if (byDisc.size < 2) return [];
  return [...byDisc.entries()]
    .sort(([a], [b]) => a - b)
    .map(([disc, discSongs]) => ({ disc, songs: discSongs }));
}
