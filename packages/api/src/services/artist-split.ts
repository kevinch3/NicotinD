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

const DELIMITERS = [/ & /i, / and /i, /\s*,\s+/, / \/ /, / \+ /, / vs\.? /i];

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
      primaryNames = [primary];
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
