/**
 * The one-glance answer to "what does this artist sound like?" for the artist
 * page header (#1572), derived from the primary-genre share (each track
 * counted once, shares sum to 1 — `PrimaryGenreShare` on the API).
 *
 * - `single`: one genre dominates (≥ {@link SINGLE_MIN}).
 * - `pair`: two genres together dominate, and the second is no stray tag.
 * - `mixed`: no small set explains the catalogue; the header says so rather
 *   than naming a genre that covers a third of it.
 *
 * The thresholds are provisional: tune them from a prod measurement, here only.
 */
export const SINGLE_MIN = 0.6;
export const PAIR_MIN = 0.7;
export const SECOND_MIN = 0.2;

export interface ShareSlice {
  genre: string;
  weight: number;
}

export type HeadlineGenres =
  | { kind: 'single'; genres: [string] }
  | { kind: 'pair'; genres: [string, string] }
  | { kind: 'mixed'; genres: string[] };

/** `null` when there is no genre data at all — the header then shows nothing. */
export function headlineGenres(slices: readonly ShareSlice[]): HeadlineGenres | null {
  // "Other" is a fold of the tail, never a genre to headline.
  // Ties break by name, matching the API's own `count DESC, genre ASC`.
  const named = slices
    .filter((s) => s.genre !== 'Other')
    .sort((a, b) => b.weight - a.weight || a.genre.localeCompare(b.genre));
  const [first, second] = named;
  if (!first) return null;
  if (first.weight >= SINGLE_MIN) return { kind: 'single', genres: [first.genre] };
  if (second && second.weight >= SECOND_MIN && first.weight + second.weight >= PAIR_MIN) {
    return { kind: 'pair', genres: [first.genre, second.genre] };
  }
  return { kind: 'mixed', genres: named.slice(0, 3).map((s) => s.genre) };
}
