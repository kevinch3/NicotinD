// Shared, dependency-free query builders for slskd hunts.
//
// The album + per-track hunts search Soulseek by literal text. The Soulseek
// server drops any search that carries a banned word (many artist names) and
// answers nothing, so when the plain queries find no confident folder the hunt
// retries with those words wildcarded: a leading `*` is the network's own
// wildcard, and `*orillaz` matches the same paths as the word it replaces.
//
// Pure (no slskd/IO/node deps) so it is the ONE source for both the addon's
// hunter and the web hunt modal (which shows the exact query strings a hunt fires).

// Combining diacritical marks block (U+0300–U+036F), stripped after NFD decompose.
const COMBINING_MARKS = /[̀-ͯ]/g;

/** NFD-decompose, drop combining diacritical marks, lowercase. "Ídolo" → "idolo". */
export function fold(s: string): string {
  return s.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();
}

/**
 * Strip trailing bracketed qualifiers + "feat./ft./featuring/with …" clauses from
 * a title, leaving its "core". Peers routinely name a file without the
 * "(feat …)"/"(Remix)"/"(2024 Remaster)" suffix the Lidarr title carries.
 */
export function stripTitleQualifiers(title: string): string {
  return title
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/\b(feat\.?|ft\.?|featuring|with)\b.*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Small multilingual function-word set (EN/ES/FR/PT): filler no ban targets, and
// too common to wildcard without flooding the result.
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  'in',
  'on',
  'at',
  'to',
  'for',
  'with',
  'from',
  'by',
  'el',
  'la',
  'los',
  'las',
  'de',
  'del',
  'y',
  'un',
  'una',
  'le',
  'les',
  'des',
  'et',
  'e',
  'o',
]);

// A wildcarded word keeps at least this many literal characters, so `*2` (U2)
// or `*he` never stand in for a name.
const MIN_WILDCARD_REMAINDER = 3;

/**
 * One word rewritten so the server's banned-word filter no longer sees it
 * (`Gorillaz` → `*orillaz`), or unchanged when wildcarding it would only
 * broaden the search: filler words, short words, and words that do not start
 * with a letter. See docs/album-hunt.md "A banned word".
 */
export function wildcardWord(word: string): string {
  const [first, ...rest] = [...word];
  if (!first || !/\p{L}/u.test(first)) return word;
  if (rest.length < MIN_WILDCARD_REMAINDER || STOPWORDS.has(fold(word))) return word;
  return `*${rest.join('')}`;
}

/**
 * A phrase with its words wildcarded: only those that belong to `artist` when
 * one is given (album and title words stay literal, so the query stays as
 * narrow as the plain one), every word otherwise.
 */
export function wildcardPhrase(phrase: string, artist?: string): string {
  const artistWords =
    artist === undefined ? null : new Set(fold(artist).split(/\s+/).filter(Boolean));
  return phrase
    .trim()
    .split(/\s+/)
    .map((w) => (!artistWords || artistWords.has(fold(w)) ? wildcardWord(w) : w))
    .join(' ');
}

/** The two unmodified queries every hunt runs first. */
export function baseQueries(artist: string, album: string): string[] {
  return [`${artist} ${album}`, `${artist} - ${album}`];
}

/** Keep only novel, non-empty variants (order preserved), given already-seen queries. */
function dedupe(variants: string[], seed: string[]): string[] {
  const seen = new Set(seed.map((q) => q.toLowerCase().trim()));
  const out: string[] = [];
  for (const raw of variants) {
    const v = raw.replace(/\s+/g, ' ').trim();
    const key = v.toLowerCase();
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/**
 * The retry queries for an album hunt whose plain queries found nothing
 * confident: the same phrase with the artist's words wildcarded, then with
 * every word wildcarded (a ban on an album word), then the artist-wildcarded
 * phrase without the title's bracketed qualifier, which peers often omit.
 * De-duped against the base queries and each other, so an artist with no
 * word worth wildcarding yields none.
 */
export function buildSkewedQueries(artist: string, album: string, base: string[]): string[] {
  const a = artist.trim();
  const al = album.trim();
  const core = stripTitleQualifiers(al);

  const variants = [
    wildcardPhrase(`${a} ${al}`, a),
    wildcardPhrase(`${a} ${al}`),
    core && core !== al ? wildcardPhrase(`${a} ${core}`, a) : '',
  ];

  return dedupe(variants, base);
}

/** Convenience: the retry queries against the standard base. Used by the web hunt modal. */
export function skewedQueries(artist: string, album: string): string[] {
  return buildSkewedQueries(artist, album, baseQueries(artist, album));
}

/**
 * Per-track queries, fired in order until one returns a hit: the exact phrase,
 * then the wildcarded retries of {@link buildSkewedQueries} at track
 * granularity, then the qualifier-stripped title for a peer that omits
 * "(feat …)".
 */
export function buildTrackQueries(artist: string, title: string): string[] {
  const a = artist.trim();
  const t = title.trim();
  const exact = `${a} ${t}`;
  const stripped = stripTitleQualifiers(t);

  const variants = [
    exact,
    wildcardPhrase(exact, a),
    wildcardPhrase(exact),
    stripped && stripped !== t ? `${a} ${stripped}` : '',
    stripped && stripped !== t ? wildcardPhrase(`${a} ${stripped}`, a) : '',
  ];

  return dedupe(variants, []);
}
