// Shared query-matching primitives for the search lanes.
//
// Both the local library provider and the catalog (Lidarr/MusicBrainz) lane need
// the same accent-insensitive, per-token AND matching so a multi-word query like
// "C. Tangana Ídolo" resolves to the right release and a rare second word can't
// be dropped in favour of a common first token. Kept here so there's one
// definition instead of a copy per provider.

// Combining diacritical marks block (U+0300–U+036F), stripped after NFD decompose.
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Fold text for accent-insensitive matching: NFD-decompose, drop combining
 * marks (diacritics — "Ídolo" → "idolo", "niño" → "nino"), lowercase. Base
 * letters (incl. non-Latin scripts) are preserved so Cyrillic/etc. queries
 * still match.
 */
export function fold(s: string): string {
  return s.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();
}

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
