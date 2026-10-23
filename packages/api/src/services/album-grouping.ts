/**
 * Collapse the hunt flow's fragmented album rows into one logical album.
 *
 * Several hunt-flow artifacts make Navidrome report multiple "albums" for what is
 * really one release, none fixable by Navidrome's PID config:
 *
 *  1. **Mixed MBIDs in one folder.** The hunt/fallback drops foreign-edition
 *     files (deluxe/bonus/acoustic, alternate pressings from per-track recovery)
 *     into a single `<Artist>/<Album>` folder; each carries its own
 *     `musicbrainz_albumid`, and Navidrome keys album identity on that — so one
 *     folder fragments into a card per MBID.
 *  2. **Punctuation-variant sibling folders.** Re-hunts derive the folder name
 *     from inconsistent title strings ("¡Bang! ¡Bang!... Estás liquidado" vs
 *     "¡Bang! ¡Bang! … Estás liquidado"), producing distinct folders.
 *  3. **Edition variants.** Separate hunts pull the base album, a 2011 remaster,
 *     and a deluxe edition — distinct titles/folders for one album.
 *
 * The syncer canonicalizes instead: albums sharing a group key collapse to one
 * `library_albums` row and every song is remapped onto the canonical id. The key
 * strips diacritics, punctuation, and edition qualifiers so all of the above
 * collide, while keeping real title words so genuinely distinct albums
 * ("Greatest Hits" vs "Greatest Hits II") stay separate.
 */

export { normalizeForGrouping, normalizeArtistForGrouping, albumGroupKey } from '@nicotind/core';

/**
 * Pick the canonical album id for a merge group. Most songs wins (the fullest
 * rip becomes the representative); ties break on the lexicographically smallest
 * id so the choice is stable across syncs.
 */
export function pickCanonicalId(members: Array<{ id: string; songCount: number }>): string {
  return [...members].sort(
    (a, b) => b.songCount - a.songCount || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )[0]!.id;
}

/**
 * Choose which spelling of an artist name the library DISPLAYS, given every
 * spelling its own files carry.
 *
 * The candidates all fold to one `artistId` — `normalizeArtistForGrouping`
 * NFD-decomposes, strips combining marks, lowercases and collapses whitespace —
 * so this never affects identity, grouping, search, radio or acquisition. It
 * decides one thing: the string a user reads on the album card and the artist
 * tile, which on prod disagreed for 178 albums across 54 artists.
 *
 * MUST be a **total, stable** ordering — the same multiset of candidates in any
 * order returns the same answer. That is the whole point: the old value was
 * `readdir` order, so it was not merely arbitrary but unstable, and a one-track
 * incremental scan re-elected a 23-track album's artist (`Gigi D'Agostino` →
 * `GIGI D'AGOSTINO`). `mostCommonGenre`'s first-seen tie-break is NOT a model to
 * copy here; it has the same latent defect one level down.
 *
 * The picked string is frequently not the majority spelling in the artist's own
 * tags today: `Cultura Profetica` is displayed while 126 of 126 song tags say
 * `Cultura Profética`, and 16 tiles drop an accent their own files carry.
 *
 * @param candidates every spelling seen, in encounter order, at least one.
 * @returns the spelling to store in `library_albums.artist` / `library_artists.name`.
 */
export function pickDisplayName(candidates: string[]): string {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    const v = c.trim();
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  if (counts.size === 0) return candidates[0] ?? '';
  return [...counts.entries()].sort(compareDisplayCandidates)[0]![0];
}

/** Combining marks — what NFD separates an accent into. */
const COMBINING_MARKS = /\p{M}/gu;

/** Diacritics carried by a string, counted on its decomposed form. */
function accentCount(s: string): number {
  return s.normalize('NFD').match(COMBINING_MARKS)?.length ?? 0;
}

/** True for a string with letters and no lowercase one — a tagger's ALL CAPS. */
function isShouted(s: string): boolean {
  return /\p{L}/u.test(s) && !/\p{Ll}/u.test(s);
}

/**
 * The ordering behind `pickDisplayName`, best-first. Every step is decided on
 * the candidate strings alone, so it is total and independent of input order.
 *
 *  1. **Frequency.** The album's own files are the best evidence available, and
 *     it is what the sibling reductions (`name`, `mostCommonGenre`) already use.
 *  2. **Diacritics.** A stripped accent is information the other spelling has
 *     and this one lost — `Rafaga` cannot be recovered from `Ráfaga`, but the
 *     reverse is free. Sixteen prod tiles drop an accent their own tags carry.
 *  3. **Not shouted.** ALL CAPS is overwhelmingly a tagger artifact
 *     (`TASH SULTANA`, `RICARDO ARJONA`); an all-lowercase styling like
 *     `deadmau5` is deliberate far more often, so only upper is penalised.
 *     Ranked below frequency, so a genuinely all-caps act (`ARTBAT`, 6 of 6)
 *     keeps its name.
 *  4. **Alphabetical**, purely to make the order total — it is what stops the
 *     answer depending on `readdir`. `localeCompare` with an EXPLICIT locale,
 *     not `<`: code-point order sorts every capital before every lowercase
 *     letter, which is an encoding artifact rather than an ordering anyone
 *     means, and an implicit locale would make the result depend on the host —
 *     reintroducing exactly the instability this function exists to remove.
 */
function compareDisplayCandidates(a: [string, number], b: [string, number]): number {
  if (a[1] !== b[1]) return b[1] - a[1];
  const accents = accentCount(b[0]) - accentCount(a[0]);
  if (accents !== 0) return accents;
  const shouted = Number(isShouted(a[0])) - Number(isShouted(b[0]));
  if (shouted !== 0) return shouted;
  const alpha = a[0].localeCompare(b[0], 'en');
  if (alpha !== 0) return alpha;
  // localeCompare can call two distinct strings equal; code points cannot.
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}
