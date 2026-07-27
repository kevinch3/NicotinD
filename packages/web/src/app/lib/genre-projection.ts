import type { GenreSlice } from '../components/genre-radar/genre-radar.component';

/**
 * Project what an artist's genre spread becomes if a curator fix is applied —
 * the "after" half of the before/after reclassification view (issue #222).
 *
 * why: the append-vs-replace choice (issue #260) is the single most consequential
 * control in the genre modal and its effect was invisible until you pressed
 * Save. `replace` is *required* when an artist's tag genres are broad and wrong,
 * because `genreSetCloseness` is a position-blind MAX and one retained broad
 * genre masks the fix — but the same setting flattened 34 Ana Tijoux songs onto
 * a single genre. That is the difference this preview makes visible: replace
 * collapses the radar to spikes on exactly the chosen genres, append keeps the
 * existing shape and raises the chosen ones.
 *
 * Weights are shares of the artist's landed tracks carrying that genre (they
 * deliberately don't sum to 1 — sets overlap; see docs/genre-radar.md), so a
 * curator fix that writes the same genres onto *every* track lands each chosen
 * genre at exactly 1.0.
 *
 * Pure and synchronous: the projection is fully determined by data the modal
 * already holds, so the preview updates as the curator types, with no request.
 */
export function projectGenreDistribution(
  before: GenreSlice[],
  chosen: string[],
  mode: 'append' | 'replace',
  trackCount: number,
): GenreSlice[] {
  // Dedupe case-insensitively but keep the curator's own capitalisation — the
  // chips and the stored value use what they typed.
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const g of chosen.map((s) => s.trim()).filter(Boolean)) {
    const key = g.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(g);
  }

  // Every track gets the chosen genres, so each lands at full coverage.
  const full = (genre: string): GenreSlice => ({ genre, count: trackCount, weight: 1 });

  if (mode === 'replace') {
    // Nothing of the previous spread survives — that is the whole point of
    // replace, and the whole risk of it.
    return picked.map(full);
  }

  // Append: existing coverage is untouched, and anything chosen rises to full.
  const kept = before.filter((s) => !seen.has(s.genre.toLowerCase()));
  return [...picked.map(full), ...kept];
}

/**
 * Genres the fix would drop entirely, in the order they currently rank.
 *
 * Surfaced separately because losing coverage is the outcome a curator most
 * needs to notice, and a radar communicates *shape* better than absence — an
 * axis that simply disappears is easy to miss between two charts.
 */
export function genresLostBy(
  before: GenreSlice[],
  chosen: string[],
  mode: 'append' | 'replace',
): string[] {
  if (mode === 'append') return [];
  const keep = new Set(chosen.map((s) => s.trim().toLowerCase()).filter(Boolean));
  return before.filter((s) => !keep.has(s.genre.toLowerCase())).map((s) => s.genre);
}
