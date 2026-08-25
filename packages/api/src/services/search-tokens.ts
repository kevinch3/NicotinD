// Shared query-matching primitives for the search lanes.
//
// Both the local library provider and the catalog (Lidarr/MusicBrainz) lane need
// the same accent-insensitive, per-token AND matching so a multi-word query like
// "C. Tangana Ídolo" resolves to the right release and a rare second word can't
// be dropped in favour of a common first token. Kept here so there's one
// definition instead of a copy per provider.

// `fold` (NFD-decompose, drop combining marks, lowercase — "Ídolo" → "idolo",
// "niño" → "nino"; base letters incl. non-Latin scripts are preserved) is the
// one accent-folding primitive, and it lives in the addon-sdk because the hunt
// engine needs it too. Re-exported here so the search lanes keep importing it
// from their own module.
import { fold } from '@nicotind/core';
export { fold };

/**
 * Split a query into folded tokens on any non-alphanumeric boundary (Unicode
 * aware, so "C. Tangana Ídolo" → ["c", "tangana", "idolo"]). Every token must
 * match for a row to qualify (AND semantics).
 */
export function tokenize(q: string): string[] {
  return fold(q)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** True when every query token is a substring of the folded haystack. */
export function matchesAllTokens(haystack: string, tokens: string[]): boolean {
  const h = fold(haystack);
  return tokens.every((t) => h.includes(t));
}

/**
 * Comparator that ranks matched rows: an exact folded-name match first, then a
 * name that starts with the whole folded query, then a name starting with the
 * first token, then alphabetical. Keeps the most-relevant hit at the top of
 * each capped section without a heavy scorer. Shared by the local search
 * provider and the playlist-proposals scorer.
 */
export function rankBy<T>(tokens: string[], nameOf: (row: T) => string): (a: T, b: T) => number {
  const joined = tokens.join(' ');
  const score = (row: T): number => {
    const n = fold(nameOf(row));
    if (n === joined) return 0;
    if (n.startsWith(joined)) return 1;
    if (n.startsWith(tokens[0]!)) return 2;
    return 3;
  };
  return (a, b) => score(a) - score(b) || nameOf(a).localeCompare(nameOf(b));
}
