/**
 * Discogs top-level `genres[]` → canonical library genre mapping (issue #194).
 *
 * Discogs' *top-level* genre vocabulary is a small, closed set (~15 entries) —
 * but two entries carry commas (`Folk, World, & Country`) and one a slash
 * (`Funk / Soul`). `splitGenres` (genre-split.ts) splits every incoming frame
 * on `;,|` and conditionally on `/`, so ingesting Discogs genres verbatim
 * shatters one genre into fragments (`Folk` / `World` / `& Country`) — and
 * those fragments then join the library's known-genre vocabulary, which makes
 * the `/`-split heuristic *more permissive* for every future tag. The pollution
 * is self-reinforcing and survives rescans.
 *
 * The fix: map Discogs' closed genre list to comma/slash-free canonical genres
 * *before* anything reaches `splitGenres`. Open-ended Discogs `styles[]` are NOT
 * mapped here — they go through the existing `library_genre_aliases` path.
 */

/** Discogs' documented closed top-level genre list (discogs.com/help). */
export const DISCOGS_TOP_LEVEL_GENRES = [
  'Blues',
  'Brass & Military',
  "Children's",
  'Classical',
  'Electronic',
  'Folk, World, & Country',
  'Funk / Soul',
  'Hip Hop',
  'Jazz',
  'Latin',
  'Non-Music',
  'Pop',
  'Reggae',
  'Rock',
  'Stage & Screen',
] as const;

/**
 * Overrides for the entries that would shatter or that need canonicalizing to
 * the library's spelling. `[]` drops the genre. Anything not listed passes
 * through unchanged (`&` is never a `splitGenres` separator, so `Brass &
 * Military` / `Stage & Screen` survive intact and stay as-is).
 */
const CANONICAL: Record<string, string[]> = {
  'folk, world, & country': ['Folk', 'World', 'Country'],
  'funk / soul': ['Funk', 'Soul'],
  'hip hop': ['Hip-Hop'],
  'non-music': [],
};

const key = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Map raw Discogs top-level genres to canonical, separator-free library genres.
 * De-duplicates (case-insensitive) preserving first-seen order.
 */
export function mapDiscogsGenres(genres: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of genres) {
    const k = key(raw);
    if (!k) continue;
    const mapped = CANONICAL[k] ?? [raw.trim().replace(/\s+/g, ' ')];
    for (const g of mapped) {
      const gk = key(g);
      if (!gk || seen.has(gk)) continue;
      seen.add(gk);
      out.push(g);
    }
  }
  return out;
}
