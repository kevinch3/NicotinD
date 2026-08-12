import { fold } from './hunt-queries.js';

/**
 * Title matching shared by the hunt engine (peer-file ↔ canonical-track
 * matching) and the library layer (organizer, completeness, track-select,
 * job-store) — promoted from `album-hunter.service.ts` so the slskd addon
 * extraction doesn't drag the library layer with it.
 */

export function normalizeTitle(title: string): string {
  // Diacritics are folded (via the shared `fold`) *before* the ASCII-only
  // `[^\w\s]` strip, so an accented "canción" and a peer's unaccented "cancion"
  // both reduce to the same string — critical for this Latin-American-heavy
  // library. `fold` already lowercases + NFD-strips combining marks.
  return fold(title)
    .replace(/^\d+[\s.\-]+/, '') // strip leading track numbers
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function titlesOverlap(canonical: string, filename: string): boolean {
  if (canonical === filename) return true;
  // Check if the canonical words are mostly in the filename
  const cWords = canonical.split(' ').filter(Boolean);
  const fWords = new Set(filename.split(' ').filter(Boolean));
  const overlap = cWords.filter((w) => fWords.has(w)).length;
  return cWords.length > 0 && overlap / cWords.length >= 0.7;
}
