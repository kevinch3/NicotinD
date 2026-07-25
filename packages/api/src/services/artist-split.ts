import { normalizeArtistForGrouping } from './album-grouping';

export interface ArtistCredit {
  name: string;
  role: 'primary' | 'featuring';
}

/**
 * Split authority sets (all values normalized via {@link normalizeArtistForGrouping}).
 *
 * - `confirmedArtists` — names known to be a **real individual artist** (they appear
 *   atomically somewhere in the library, or a Lidarr/MB lookup confirmed them). A
 *   compound is only split when *every* candidate part is confirmed.
 * - `canonicalWhole` — compound strings that Lidarr/MB says are **one act** (bands,
 *   duos like "Wisin & Yandel"). These are kept whole even when both members are
 *   independently confirmed.
 *
 * With empty sets the parser keeps every compound whole (the safe default) — it only
 * ever splits on positive confirmation, never mangling a band/duo name.
 */
export interface KnownArtistSets {
  confirmedArtists?: ReadonlySet<string>;
  canonicalWhole?: ReadonlySet<string>;
}

const FEAT_BRACKET = /\s*[([]\s*(?:feat\.?|ft\.?|featuring|with|w\/)\s+([^)\]]+)[)\]]/gi;
const FEAT_BARE = /\s+(?:feat\.?|ft\.?|featuring|with|w\/)\s+(.+)$/i;

// `;` is a known artist divider in our acquisition sources (mirrors genre-split's
// separators). Like the others, it only *splits* when every part is a confirmed
// artist — see the gate in splitArtists — so a stray semicolon never mangles a name.
const DELIMITERS = [/\s*;\s*/, / & /i, / and /i, /\s*,\s+/, / \/ /, / \+ /, / vs\.? /i];

const WORD_BOUNDARY_DELIMITERS = [
  { pattern: /\bx\b/i, text: ' x ' },
  { pattern: /\by\b/i, text: ' y ' },
  { pattern: /\bcon\b/i, text: ' con ' },
];

function normalize(s: string): string {
  return normalizeArtistForGrouping(s);
}

function extractFeaturing(raw: string): { primary: string; featuring: string[] } {
  const featuringNames: string[] = [];

  let primary = raw.replace(FEAT_BRACKET, (_match, names: string) => {
    featuringNames.push(...splitOnDelimiters(names.trim()));
    return '';
  });

  const bareMatch = primary.match(FEAT_BARE);
  if (bareMatch) {
    featuringNames.push(...splitOnDelimiters(bareMatch[1].trim()));
    primary = primary.slice(0, bareMatch.index).trim();
  }

  return { primary: primary.trim(), featuring: featuringNames };
}

/**
 * Break a segment into candidate artist names on the known delimiters. This is purely
 * lexical detection — it does NOT decide whether the split *should* happen (that gate
 * lives in {@link splitArtists} and requires confirmation). Exported so the scanner can
 * ask "is this raw name a single atomic artist?" via {@link isAtomicArtist}.
 */
export function splitOnDelimiters(segment: string): string[] {
  for (const delim of DELIMITERS) {
    const parts = segment
      .split(delim)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 1) return parts.flatMap((p) => splitOnDelimiters(p));
  }

  for (const { pattern } of WORD_BOUNDARY_DELIMITERS) {
    const match = segment.match(pattern);
    if (match && match.index != null) {
      const before = segment.slice(0, match.index).trim();
      const after = segment.slice(match.index + match[0].length).trim();
      if (before && after) {
        return [...splitOnDelimiters(before), ...splitOnDelimiters(after)];
      }
    }
  }

  return [segment];
}

/**
 * True when `raw` denotes a single individual artist — no featuring credit and no
 * delimiter that would split it. The scanner uses this to decide which raw library
 * artist strings seed the `confirmedArtists` set (a compound must never confirm itself).
 */
export function isAtomicArtist(raw: string): boolean {
  if (!raw || raw === 'Unknown Artist') return true;
  const { primary, featuring } = extractFeaturing(raw);
  if (featuring.length > 0) return false;
  return splitOnDelimiters(primary).length === 1;
}

/** Shortest artist segment a concatenation split may produce ("U2"/"M83" are real). */
const MIN_ARTIST_SEGMENT = 2;

/**
 * Segment a delimiter-less artist mash ("2 MinutosTruenoDie Toten Hosen" — three
 * acts run together with no separator) into its constituent artists, or null when
 * it can't be covered entirely by confirmed real artists.
 *
 * Direct mirror of the scanner's `segmentConcatenatedGenre` (`genre-split.ts`), with
 * the same two safety rules — a delimiter-less mash has the same class of defect as a
 * mashed genre tag and the same shape of fix:
 *
 * - **Cuts only at an uppercase letter directly preceded by a letter or digit.** That
 *   is what a mash looks like ("...TruenoDie..."), and it is what stops a real name
 *   from being torn apart: "Die Toten Hosen", "Wu-Tang Clan" and "Sam & Dave" have no
 *   legal internal cut (a space or hyphen protects the boundary), so they can never be
 *   split by this path.
 * - **Every segment must be a confirmed real artist** (`resolveConfirmed` returns the
 *   confirmed spelling or null), all-or-nothing — the exact same discipline as
 *   {@link splitArtists}' delimiter gate, so it never mints a band name into pieces.
 *
 * Longest segment first (with backtracking) so a multi-word member wins over its own
 * prefix. The confirmation gate makes it safe to apply automatically at scan time.
 */
export function segmentConcatenatedArtist(
  value: string,
  resolveConfirmed: (s: string) => string | null,
): string[] | null {
  const v = value.trim().replace(/\s+/g, ' ');
  if (v.length < MIN_ARTIST_SEGMENT * 2) return null;

  // Legal cut positions: index i splits [0,i) / [i,…) when v[i] is uppercase and
  // v[i-1] is alphanumeric (so a space or a hyphen protects a compound name).
  const cuts: number[] = [];
  for (let i = 1; i < v.length; i++) {
    if (/\p{Lu}/u.test(v[i]!) && /[\p{L}\p{N}]/u.test(v[i - 1]!)) cuts.push(i);
  }
  if (cuts.length === 0) return null;

  const ends = [...cuts, v.length];
  const memo = new Map<number, string[] | null>();
  const solve = (start: number): string[] | null => {
    if (start === v.length) return [];
    const cached = memo.get(start);
    if (cached !== undefined) return cached;
    memo.set(start, null); // cycle guard (unreachable — ends strictly increase)
    // Longest candidate segment first.
    for (let i = ends.length - 1; i >= 0; i--) {
      const end = ends[i]!;
      if (end <= start) continue;
      // The whole value as one segment is not a split (even if it is confirmed
      // atomic — an atomic mash confirms itself, exactly the case we want to break).
      if (start === 0 && end === v.length) continue;
      const piece = v.slice(start, end).trim();
      if (piece.length < MIN_ARTIST_SEGMENT) continue;
      const confirmed = resolveConfirmed(piece);
      if (!confirmed) continue;
      const rest = solve(end);
      if (rest) {
        const out = [confirmed, ...rest];
        memo.set(start, out);
        return out;
      }
    }
    memo.set(start, null);
    return null;
  };

  const segments = solve(0);
  return segments && segments.length >= 2 ? segments : null;
}

export function splitArtists(raw: string, known: KnownArtistSets = {}): ArtistCredit[] {
  const confirmedArtists = known.confirmedArtists ?? EMPTY;
  const canonicalWhole = known.canonicalWhole ?? EMPTY;

  if (!raw || raw === 'Unknown Artist') return [{ name: raw || 'Unknown Artist', role: 'primary' }];

  const { primary, featuring } = extractFeaturing(raw);

  let primaryNames: string[];
  if (canonicalWhole.has(normalize(primary))) {
    // Lidarr/MB says this compound is one act (band/duo) — never split it.
    primaryNames = [primary];
  } else {
    const candidates = splitOnDelimiters(primary);
    // Conservative: split only when every candidate is an independently confirmed
    // artist. Otherwise keep the string whole (never mangle a band name).
    if (candidates.length > 1 && candidates.every((c) => confirmedArtists.has(normalize(c)))) {
      primaryNames = candidates;
    } else {
      // No delimiter split. Last resort (issue #212): a delimiter-less mash of
      // confirmed artists ("2 MinutosTruenoDie Toten Hosen"). Same all-confirmed
      // gate, so a real single artist is never carved up.
      primaryNames = segmentConcatenatedArtist(primary, (s) =>
        confirmedArtists.has(normalize(s)) ? s : null,
      ) ?? [primary];
    }
  }

  const result: ArtistCredit[] = primaryNames.map((name) => ({ name, role: 'primary' as const }));
  // Featuring credits are extracted unconditionally — a "feat. X" is an explicit,
  // unambiguous credit, so it never needs library confirmation to be surfaced.
  for (const name of featuring) {
    result.push({ name, role: 'featuring' });
  }

  return result;
}

const EMPTY: ReadonlySet<string> = new Set();

export function formatArtistDisplay(artists: ArtistCredit[]): string {
  const primaries = artists.filter((a) => a.role === 'primary');
  const feats = artists.filter((a) => a.role === 'featuring');

  let display = primaries.map((a) => a.name).join(' & ');
  if (feats.length > 0) {
    display += ` feat. ${feats.map((a) => a.name).join(' & ')}`;
  }
  return display;
}
