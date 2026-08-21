/**
 * Corroborate an ambiguous artist MBID against the discography we actually hold
 * (issue #610).
 *
 * Lidarr's `/artist/lookup` returns every artist carrying a name, so a homonym
 * ("Emilia" → ten exact hits: a Swedish MC, Emilia Rydberg, a Macross
 * character, …, and the Argentinian Emilia Mernes the library holds) leaves
 * name equality with no discriminating power. `pickMbidHit` reports those as
 * "I don't know"; this module breaks the tie with the one signal we own and
 * the name doesn't carry — which release titles are on disk.
 *
 * Same discipline as `corroboratesLidarrHit` (services/lidarr-confidence.ts):
 * corroborate against evidence, never trust a string match.
 */

export interface MbidCandidate {
  mbid: string;
  /** The candidate's MusicBrainz release-group titles. */
  releaseGroups: readonly string[];
}

/**
 * Fold a release title for comparison: lowercase, strip accents, and reduce
 * anything that isn't a letter or digit to a single space. Deliberately
 * aggressive — real library titles differ from MusicBrainz's by case
 * (`como si no importara` / `Como si no importara`), separators
 * (`La_Playlist.mpeg` / `La_playlist.mpeg`), leading punctuation (`mp3` /
 * `.mp3`) and trailing emoji (`pasarella 👠`).
 */
export function foldTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Pick the candidate whose MusicBrainz discography corroborates the albums we
 * hold, or null when the evidence doesn't single one out.
 *
 * Returning null is always safe: the caller leaves the MBID unresolved, the
 * artist keeps no bio/origin rather than the *wrong* bio/origin, and a curator
 * can still set it by hand (`PUT /artists/:id/mbid`).
 */
export const MIN_CORROBORATING_TITLES = 2;

export function pickByDiscographyOverlap(
  candidates: readonly MbidCandidate[],
  libraryAlbums: readonly string[],
): string | null {
  const held = new Set(libraryAlbums.map(foldTitle).filter(Boolean));
  if (held.size === 0 || candidates.length === 0) return null;

  const scored = candidates.map((c) => {
    const titles = new Set(c.releaseGroups.map(foldTitle).filter(Boolean));
    let overlap = 0;
    for (const t of held) if (titles.has(t)) overlap++;
    return { mbid: c.mbid, overlap };
  });

  const best = scored.reduce((a, b) => (b.overlap > a.overlap ? b : a));
  // A single shared title is not evidence: generic release names (".mp3") and
  // covers collide across unrelated artists, and a wrong pick here is written
  // to a cache that then feeds bio, origin, genres and artwork. Requiring two
  // means a thin library can leave a homonym unresolved — the deliberate
  // trade, since no bio beats another artist's bio.
  if (best.overlap < MIN_CORROBORATING_TITLES) return null;
  // A tie is still "I don't know": picking either reintroduces the coin flip
  // this whole path exists to remove.
  if (scored.some((s) => s.mbid !== best.mbid && s.overlap === best.overlap)) return null;
  return best.mbid;
}
