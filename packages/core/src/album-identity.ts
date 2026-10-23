/**
 * Album identity, shared by the API and the web (#1539).
 *
 * `albumGroupKey` is the key the scanner hashes into a landed album's id
 * (`albumIdFor`), so every Get lane — a catalog card, a peer folder, a URL, the
 * auto-acquire poller — can name the album it is about to fetch in the same
 * terms the library will file it under. Moved verbatim from the API's
 * `album-grouping.ts`, which re-exports it: changing one character here moves
 * album ids.
 *
 * `sameAlbum` is the looser question a duplicate guard asks — "is this the
 * album already downloading?" — where the two sides were named by different
 * sources: a catalog credits "Damian Lazarus", the peer's folder and tags
 * "Damian Lazarus & The Ancient Moons".
 */
import { cleanFolderName, isGenericFolderName } from './utils/folder-name.js';

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

// Separators a collaboration credit joins its acts with. "x" and "vs" need word
// boundaries so "Xavier" and "Vsevolod" survive.
const CREDIT_SEPARATORS =
  /\s*(?:&|\+|,|;|\/|\band\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bvs\.?|\bx\b)\s*/i;

/** The acts a credit names, normalized: "Damian Lazarus & The Ancient Moons" → both. */
export function artistCredits(artist: string): string[] {
  const whole = normalizeArtistForGrouping(artist);
  const parts = artist.split(CREDIT_SEPARATORS).map(normalizeArtistForGrouping).filter(Boolean);
  return [...new Set([whole, ...parts].filter(Boolean))];
}

/** True when two credits share an act. */
export function artistsOverlap(a: string, b: string): boolean {
  const theirs = new Set(artistCredits(b));
  return artistCredits(a).some((credit) => theirs.has(credit));
}

const ARTIST_TITLE = /^(.+?)\s+[-–—]\s+(.+)$/;

/** A title with a leading "<one of these artists> - " dropped (a folder-name album). */
function titleWithoutArtist(title: string, artists: string[]): string {
  const m = title.match(ARTIST_TITLE);
  if (m && artists.some((artist) => artistsOverlap(m[1]!, artist))) return m[2]!;
  return title;
}

export interface AlbumIdentity {
  artist: string;
  title: string;
}

/**
 * Whether two namings point at one album: the titles fold to the same grouping
 * key (editions, years and punctuation collapse; "Artist - " folder prefixes are
 * dropped) and the credits share an act.
 */
export function sameAlbum(a: AlbumIdentity, b: AlbumIdentity): boolean {
  if (!a.artist || !a.title || !b.artist || !b.title) return false;
  const artists = [a.artist, b.artist];
  const titleA = normalizeForGrouping(titleWithoutArtist(a.title, artists));
  const titleB = normalizeForGrouping(titleWithoutArtist(b.title, artists));
  return titleA !== '' && titleA === titleB && artistsOverlap(a.artist, b.artist);
}

/**
 * Best-effort identity of a peer folder from its path, for a grab that came
 * with none. A leaf shaped "Artist - Album [2015]" names both (the common
 * peer convention); otherwise the parent folder is the artist and the leaf the
 * album. Generic containers ("music", "FLAC", "CD1") name nothing — a wrong
 * name blocks a later backfill (#674) and, here, would make a guard match a
 * stranger. Null fields when nothing usable is there.
 */
export function folderAlbumIdentity(directory: string): {
  artist: string | null;
  title: string | null;
} {
  const segments = directory.replace(/\\/g, '/').split('/').filter(Boolean);
  const usable = (s: string | undefined): string | null =>
    s && !isGenericFolderName(s) ? s : null;
  const leaf = segments[segments.length - 1];
  const cleaned = leaf ? cleanFolderName(leaf) : '';
  const m = cleaned.match(ARTIST_TITLE);
  const left = m?.[1]!.trim();
  const right = m?.[2]!.trim();
  // A date prefix ("2016 - Mare", "2014.04.17 - Young Alaska") is not an artist.
  const datePrefixed = left !== undefined && /^[\d.\-_ ]+$/.test(left);
  if (left && right && !datePrefixed && usable(left) && usable(right)) {
    return { artist: left, title: right };
  }
  const album = datePrefixed && right ? right : cleaned || leaf;
  return { artist: usable(segments[segments.length - 2]), title: usable(album) };
}
