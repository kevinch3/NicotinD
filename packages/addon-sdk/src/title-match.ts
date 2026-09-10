import { fold } from './hunt-queries.js';

/**
 * Title matching shared by the hunt engine (peer-file ↔ canonical-track
 * matching) and the library layer (organizer, completeness, track-select,
 * job-store) — promoted from `album-hunter.service.ts` so the slskd addon
 * extraction doesn't drag the library layer with it.
 */

/**
 * Diacritic-fold + strip-punctuation + collapse-whitespace a title that has
 * ALREADY had any leading track-number prefix removed (or never had one).
 * Exported so a caller with context this module doesn't have — the library
 * layer knows a file's own tagged track number — can decide for itself
 * whether a leading digit is a track prefix or part of the title, then finish
 * normalizing through this (issue #1089).
 */
export function foldTitleText(title: string): string {
  // Unicode-aware. This was `[^\w\s]`, and `\w` is ASCII-only, so the class
  // deleted every Cyrillic/CJK/Hangul/Arabic character and normalized those
  // titles to "" — which made `titlesOverlap`'s equality fast path call
  // every pair of them the same track, and excluded them from
  // `recordingKey` entirely. `_` is kept so ASCII titles are unaffected.
  return title
    .replace(/[^\p{L}\p{N}_\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeTitle(title: string): string {
  // Diacritics are folded (via the shared `fold`) *before* the punctuation
  // strip, so an accented "canción" and a peer's unaccented "cancion" both
  // reduce to the same string — critical for this Latin-American-heavy library.
  // `fold` already lowercases + NFD-strips combining marks.
  //
  // Strips a leading track number unconditionally: this function matches peer
  // filenames against a canonical tracklist, where a leading number is
  // virtually always a track prefix. The library layer's titles are resolved
  // tag values, where that isn't true (`foldTitleText` above).
  return foldTitleText(fold(title).replace(/^\d+[\s.\-]+/, ''));
}

export function titlesOverlap(canonical: string, filename: string): boolean {
  if (canonical === filename) return true;
  // Check if the canonical words are mostly in the filename
  const cWords = canonical.split(' ').filter(Boolean);
  const fWords = new Set(filename.split(' ').filter(Boolean));
  const overlap = cWords.filter((w) => fWords.has(w)).length;
  return cWords.length > 0 && overlap / cWords.length >= 0.7;
}
