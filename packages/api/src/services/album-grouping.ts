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

// Words that mark a bracketed/dashed segment as an *edition* qualifier rather
// than part of the album title — so "(2011 Deluxe Remaster)", "[Explicit]",
// "(2 CD)", "- Remastered Deluxe Edition" are dropped and all editions of an
// album collapse to one card. "live"/"acoustic" are deliberately absent: a live
// album is its own release and must stay distinct.
// Bare 4-digit years (1900-2099) are also treated as edition qualifiers: Soulseek
// peers frequently append the release year to folder names ("Kiss Me Once (2014)")
// and those shouldn't produce a separate album card from the canonical title.
const EDITION_SEGMENT_KEYWORDS =
  /(remaster|remasteriz|deluxe|expanded|anniversary|reissue|edition|version|mono|stereo|bonus|digipak|explicit|special|collector|\bcd\b|\bdisc\b|\b(?:19|20)\d{2}\b)/i;
// Edition adjectives that also appear *un*-bracketed ("Canción Animal Remastered").
// Kept deliberately short so real title words ("edition"/"version") aren't nuked.
const BARE_EDITION_TOKENS = /\b(remaster(ed)?|remasteriz[a-z]*|deluxe)\b/g;

/**
 * Normalize an album title for grouping: lowercase, strip diacritics, reduce
 * punctuation to spaces, and drop edition qualifiers (Deluxe/Remaster/2 CD/…)
 * so every edition of an album shares one key. Genuinely distinct titles
 * ("Greatest Hits" vs "Greatest Hits II") stay separate — only curated edition
 * keywords are removed, never bare numbers/words on their own.
 */
export function normalizeForGrouping(s: string): string {
  let raw = s;
  let strippedEdition = false;

  // 1. Drop bracketed groups that describe an edition: "(2011 Deluxe Remaster)",
  //    "[Explicit]", "(2 CD)". Non-edition parentheticals are preserved.
  raw = raw.replace(/[([][^()[\]]*[)\]]/g, (m) => {
    if (EDITION_SEGMENT_KEYWORDS.test(m)) {
      strippedEdition = true;
      return ' ';
    }
    return m;
  });
  // 2. Drop a trailing " - <edition phrase>" dash segment ("Hot Space -
  //    Remastered Deluxe Edition").
  raw = raw.replace(/\s[-–—]\s[^-–—]*$/, (m) => {
    if (EDITION_SEGMENT_KEYWORDS.test(m)) {
      strippedEdition = true;
      return ' ';
    }
    return m;
  });

  let out = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining marks (diacritics)
    .toLowerCase()
    // Punctuation/symbols → space ("¡bang!..." === "¡bang! …"). Unicode-aware:
    // an `[^a-z0-9]` class is ASCII-only, so it deleted every Cyrillic/CJK/
    // Hangul/Arabic character and collapsed those titles to "" — and this key is
    // sha1'd into the album id, so two records by one artist merged into one row
    // (issue #715's defect class, in the album-identity path).
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');

  // 3. Remove leftover un-bracketed edition adjectives.
  const before = out;
  out = out.replace(BARE_EDITION_TOKENS, ' ').replace(/\s+/g, ' ').trim();
  if (out !== before) strippedEdition = true;

  // 4. Only when an edition was removed, strip a trailing 1–2 digit disc marker
  //    ("Hot Space (2011 Deluxe Remaster) 1" → "hot space"). Guarded so real
  //    titles ("Version 2.0") keep their number when no edition text was found.
  if (strippedEdition) out = out.replace(/\s\d{1,2}$/, '').trim();

  return out;
}

/**
 * Normalize an artist name for identity matching: strip diacritics, lowercase,
 * collapse whitespace -- but do NOT strip punctuation. "Miranda!" and "Miranda"
 * are distinct artists; stripping `!` would collapse them to the same id.
 * Contrast with `normalizeForGrouping` (album titles), where punctuation
 * variants like "!Bang!..." vs "!Bang! ..." intentionally collapse.
 */
export function normalizeArtistForGrouping(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Identity for "the same album": normalized artist + normalized title. */
export function albumGroupKey(artist: string, name: string): string {
  return `${normalizeArtistForGrouping(artist)} ${normalizeForGrouping(name)}`;
}

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
