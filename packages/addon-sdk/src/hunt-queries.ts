// Shared, dependency-free query builders for slskd hunts.
//
// The album + per-track hunts search Soulseek by literal text. slskd applies a
// soft phrase-ban / search cache keyed on the *exact normalized phrase*, so when a
// base query is weak we also try "skewed" variants: strings that vary the literal
// phrase (bypassing the ban + cache) while staying faithful to the artist/album so
// the results are still relevant. Because slskd matches the search text against
// peer filenames, faithful literal variation (accent-fold, punctuation-strip,
// distinctive tokens, reorder) also *improves recall* against peers who share files
// under unaccented / differently-punctuated names.
//
// Pure (no slskd/IO/node deps) so it is the ONE source for both the API hunter and
// the web hunt modal (which shows the user the exact query strings a hunt fires) —
// no more two hand-synced copies.

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

/**
 * Replace punctuation with spaces ("&" → "and", apostrophes vanish so
 * "Guns N' Roses" → "Guns N Roses"; slashes/dots/hyphens → space), collapse
 * whitespace. A different literal phrase than the punctuated original, still
 * faithful. Keeps Unicode letters/numbers/whitespace.
 */
export function stripPunctuation(s: string): string {
  return s
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Small multilingual function-word set (EN/ES/FR/PT). Kept deliberately short so
// the distinctive-token variant drops only clear filler, never identifying words.
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

/**
 * Content tokens of a phrase (stopwords dropped, order + original casing kept).
 * "Pink Floyd The Dark Side of the Moon" → "Pink Floyd Dark Side Moon". A faithful
 * literal variant keeping the identifying words — replaces the too-generic
 * "first word of the album title".
 */
export function distinctiveTokens(phrase: string): string {
  return phrase
    .trim()
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(fold(w)))
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

/** True when a phrase has at least two content tokens (avoids over-broad 1-word queries). */
function hasTwoTokens(s: string): boolean {
  return s.split(/\s+/).filter(Boolean).length >= 2;
}

/**
 * Faithful, literal-varying skew queries for an album hunt (soft phrase-ban +
 * cache bypass). Ranked most-precise first, de-duped against the base queries and
 * each other. Every variant is a different literal string for the SAME release, so
 * results stay relevant — unlike the old last-char artist truncation, which is gone.
 */
export function buildSkewedQueries(artist: string, album: string, base: string[]): string[] {
  const a = artist.trim();
  const al = album.trim();
  const stripThe = (s: string) => s.replace(/^the\s+/i, '').trim();
  const core = stripTitleQualifiers(al);
  const distinctive = distinctiveTokens(`${a} ${al}`);

  const variants = [
    fold(`${a} ${al}`), // accent-folded / normalized (dedup drops it when unaccented)
    stripPunctuation(`${a} ${al}`), // punctuation-stripped
    `${al} ${a}`, // reorder
    ...(hasTwoTokens(distinctive) && distinctive !== `${a} ${al}` ? [distinctive] : []),
    `${stripThe(a)} ${stripThe(al)}`, // drop leading "the"
    `${a} ${core}`, // artist + qualifier-stripped title
    core, // qualifier-stripped title only
    al, // album only (broad last resort)
  ];

  return dedupe(variants, base);
}

/** Convenience: skew against the standard base queries. Used by the web hunt modal. */
export function skewedQueries(artist: string, album: string): string[] {
  return buildSkewedQueries(artist, album, baseQueries(artist, album));
}

/**
 * Per-track skew queries — the same faithful-variation idea at track granularity
 * (the per-track hunt fires these until one returns a hit). exact → accent-fold →
 * punctuation-strip → title-only → qualifier-stripped → distinctive tokens. Ordered
 * + de-duped; the old last-char artist hack is gone.
 */
export function buildTrackQueries(artist: string, title: string): string[] {
  const a = artist.trim();
  const t = title.trim();
  const exact = `${a} ${t}`;
  const stripped = stripTitleQualifiers(t);
  const distinctive = distinctiveTokens(exact);

  const variants = [
    exact,
    fold(exact), // accent-folded (dedup drops it when unaccented)
    stripPunctuation(exact), // punctuation-stripped
    t, // title only (drop artist)
    stripped && stripped !== t ? `${a} ${stripped}` : '',
    ...(hasTwoTokens(distinctive) && distinctive !== exact ? [distinctive] : []),
  ];

  return dedupe(variants, []);
}
