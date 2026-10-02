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

/**
 * A peer filename's basename, extension dropped, normalized for matching
 * against canonical titles. The slskd addon's own rule, byte for byte —
 * including the no-extension case, which drops the last character.
 */
export function normalizeFileBasename(filename: string): string {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? filename;
  const noExt = base.slice(0, base.lastIndexOf('.') || base.length);
  return normalizeTitle(noExt);
}

/**
 * Version qualifiers a peer tacks onto a title without making it another
 * recording ("(2011 Remaster)", "- Radio Edit", "[Album Version]"). A file
 * title's extra words are forgiven only when they are one of these or a bare
 * number (a year); any other extra word means a different title (#1468).
 */
const NEUTRAL_EXTRA_WORDS = new Set([
  'remaster',
  'remastered',
  'remasterizado',
  'remasterizada',
  'version',
  'edit',
  'radio',
  'live',
  'original',
  'mono',
  'stereo',
  'explicit',
  'bonus',
  'track',
  'digital',
  'album',
  'single',
]);

/**
 * Drop the `[...]`/`{...}` technical tags and a `feat. X` credit from one
 * title. A bare `feat. X` runs only to the next bracket: in `Los Tontos Feat.
 * Kiko Veneno (Live At Npr's Tiny Desk)` the live qualifier is what makes it
 * another track.
 */
function stripTitleNoise(title: string): string {
  return fold(title)
    .replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ')
    .replace(/\((?:feat|ft|featuring)\b\.?[^)]*\)/g, ' ')
    .replace(/\s(?:feat|ft|featuring)\b\.?\s[^([]*/, ' ');
}

function titleWords(title: string): string[] {
  return normalizeTitle(stripTitleNoise(title)).split(' ').filter(Boolean);
}

/**
 * The titles a peer filename may carry: its whole basename, and every suffix
 * after a ` - ` separator — so `07 Paulina Rubio - Sexy Dance` and
 * `Molotov - 02 - Molotov Coktail Party` offer the bare title too. Each
 * candidate is word-split after `normalizeTitle` (which drops a track prefix).
 */
function fileTitleCandidates(filename: string): string[][] {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? filename;
  const dot = base.lastIndexOf('.');
  const noExt = dot > 0 ? base.slice(0, dot) : base;
  const segments = noExt.split(/\s+[-–—]\s+/).map(stripTitleNoise);
  const out: string[][] = [];
  for (let i = 0; i < segments.length; i++) {
    const words = normalizeTitle(segments.slice(i).join(' ')).split(' ').filter(Boolean);
    if (words.length) out.push(words);
  }
  return out;
}

/**
 * How closely one file title matches one wanted title, 0 (no match) to 1
 * (exact). Symmetric: at least 70% of the WANTED words must be in the file
 * AND at least 70% of the FILE's words must be in the wanted title — a
 * version qualifier or a bare number among the file's extra words is not
 * counted. One-sided containment was the #1468 defect: "Arpeggiator Stories
 * Continued" carries every word of "Arpeggiator Stories" and is another track.
 */
function pairScore(wanted: string[], file: string[]): number {
  if (!wanted.length || !file.length) return 0;
  if (wanted.join(' ') === file.join(' ')) return 1;
  const fileSet = new Set(file);
  const wantedSet = new Set(wanted);
  const inWanted = wanted.filter((w) => fileSet.has(w)).length / wanted.length;
  const counted = file.filter((w) => wantedSet.has(w) || !isNeutralExtra(w));
  if (!counted.length) return 0;
  const inFile = counted.filter((w) => wantedSet.has(w)).length / counted.length;
  if (inWanted < 0.7 || inFile < 0.7) return 0;
  // Below an exact match however close, so an exact file always wins a tie.
  return ((inWanted + inFile) / 2) * 0.99;
}

function isNeutralExtra(word: string): boolean {
  return NEUTRAL_EXTRA_WORDS.has(word) || /^\d+$/.test(word);
}

/** The best {@link pairScore} of any of a file's title candidates against one title. */
export function fileTitleScore(title: string, filename: string): number {
  const wanted = titleWords(title);
  let best = 0;
  for (const cand of fileTitleCandidates(filename)) best = Math.max(best, pairScore(wanted, cand));
  return best;
}

export interface FileTitleMatch<T> {
  file: T;
  /** The wanted title (as passed in) this file was assigned to. */
  title: string;
  score: number;
}

/**
 * Assign a candidate folder's files to the wanted titles (#1468):
 *
 * 1. Each file goes to the title it matches BEST among the whole album
 *    (`canonical` plus `wanted`), and is kept only if that title is a wanted
 *    one — a file that is really an owned neighbouring track ("Arpeggiator
 *    Stories Continued", track 4) is never taken for the wanted one (track 3).
 *    A tie between two different titles is ambiguous and taken for neither.
 * 2. Each wanted title keeps only its closest file — never also the superset.
 *
 * Returned in folder order. With no `canonical`, the wanted titles are the
 * whole pool, and only the symmetric score guards against a neighbour.
 *
 * A whole-album hunt (every `canonical` title wanted) keeps the one-sided
 * `titlesOverlap` rule: no track is owned, so there is no neighbour to take by
 * mistake, and the strict score would only drop a rip's noisier names.
 */
export function matchFilesToTitles<T extends { filename: string }>(
  files: T[],
  wanted: string[],
  canonical: string[] = [],
): FileTitleMatch<T>[] {
  const pool = new Map<string, { title: string; words: string[]; wanted: boolean }>();
  for (const t of wanted) {
    const words = titleWords(t);
    const key = words.join(' ');
    if (key && !pool.has(key)) pool.set(key, { title: t, words, wanted: true });
  }
  for (const t of canonical) {
    const words = titleWords(t);
    const key = words.join(' ');
    if (key && !pool.has(key)) pool.set(key, { title: t, words, wanted: false });
  }
  const wholeAlbum = canonical.length > 0 && [...pool.values()].every((e) => e.wanted);
  const assigned: Array<FileTitleMatch<T> & { key: string; index: number }> = [];
  files.forEach((file, index) => {
    const cands = fileTitleCandidates(file.filename);
    let bestKey: string | null = null;
    let bestScore = 0;
    let tied = false;
    for (const [key, entry] of pool) {
      let score = 0;
      for (const c of cands) score = Math.max(score, pairScore(entry.words, c));
      if (score === 0) continue;
      if (score > bestScore) {
        bestKey = key;
        bestScore = score;
        tied = false;
      } else if (score === bestScore) {
        tied = true;
      }
    }
    const entry = bestKey ? pool.get(bestKey) : undefined;
    if (entry && !tied && entry.wanted) {
      assigned.push({ file, title: entry.title, score: bestScore, key: bestKey!, index });
    } else if (wholeAlbum) {
      const base = normalizeFileBasename(file.filename);
      const loose = wanted.find((t) => titlesOverlap(normalizeTitle(t), base));
      if (loose) assigned.push({ file, title: loose, score: 0, key: `#${index}`, index });
    }
  });
  const closest = new Map<string, (typeof assigned)[number]>();
  for (const m of assigned) {
    if (wholeAlbum) {
      closest.set(`#${m.index}`, m);
      continue;
    }
    const prev = closest.get(m.key);
    if (!prev || m.score > prev.score) closest.set(m.key, m);
  }
  return [...closest.values()]
    .sort((a, b) => a.index - b.index)
    .map(({ file, title, score }) => ({ file, title, score }));
}

/**
 * The tracklist titles no owned title stands for (#1473). Each owned title
 * counts toward the ONE tracklist title it matches best — so an owned
 * "Arpeggiator Stories Continued" owns track 4 and never also hides a missing
 * track 3 — under the symmetric {@link pairScore}, except that a version
 * qualifier is forgiven on either side: the tracklist's "(2009 Remaster)" is
 * still owned by a plain "Hey Jude". A tie between two titles owns both.
 */
export function titlesMissingFromOwned(tracklist: string[], owned: string[]): string[] {
  const entries = tracklist.map((title) => ({ title, words: titleWords(title) }));
  const ownedKeys = new Set<number>();
  for (const o of owned) {
    const file = titleWords(o);
    const fileSet = new Set(file);
    let best = 0;
    let at: number[] = [];
    entries.forEach((e, i) => {
      const wanted = e.words.filter((w) => fileSet.has(w) || !isNeutralExtra(w));
      const score = pairScore(wanted.length ? wanted : e.words, file);
      if (score === 0 || score < best) return;
      if (score > best) at = [];
      best = score;
      at.push(i);
    });
    for (const i of at) ownedKeys.add(i);
  }
  return entries.filter((_, i) => !ownedKeys.has(i)).map((e) => e.title);
}

/**
 * The files of a candidate folder that carry any of `titles` — the rule the
 * slskd addon scopes an album job's enqueue with, and refuses the job on when
 * it comes back empty ("the picked folder covers none of the wanted tracks").
 * Shared so a host can skip such a folder before asking (NicotinD#1209).
 * `canonical` is the album's whole tracklist; see {@link matchFilesToTitles}.
 */
export function filesMatchingTitles<T extends { filename: string }>(
  files: T[],
  titles: string[],
  canonical: string[] = [],
): T[] {
  return matchFilesToTitles(files, titles, canonical).map((m) => m.file);
}
