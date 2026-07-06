import { normalizeArtistForGrouping } from './album-grouping';

export interface ArtistCredit {
  name: string;
  role: 'primary' | 'featuring';
}

const FEAT_BRACKET = /\s*[([]\s*(?:feat\.?|ft\.?|featuring|with|w\/)\s+([^)\]]+)[)\]]/gi;
const FEAT_BARE = /\s+(?:feat\.?|ft\.?|featuring|with|w\/)\s+(.+)$/i;

const DELIMITERS = [
  / & /i,
  / and /i,
  /\s*,\s+/,
  / \/ /,
  / \+ /,
  / vs\.? /i,
];

const WORD_BOUNDARY_DELIMITERS = [
  { pattern: /\bx\b/i, text: ' x ' },
  { pattern: /\by\b/i, text: ' y ' },
  { pattern: /\bcon\b/i, text: ' con ' },
];

function normalize(s: string): string {
  return normalizeArtistForGrouping(s);
}

function isKnown(name: string, knownArtists: ReadonlySet<string>): boolean {
  return knownArtists.has(normalize(name));
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

function splitOnDelimiters(segment: string): string[] {
  for (const delim of DELIMITERS) {
    const parts = segment.split(delim).map((s) => s.trim()).filter(Boolean);
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

export function splitArtists(
  raw: string,
  knownArtists: ReadonlySet<string> = new Set(),
): ArtistCredit[] {
  if (!raw || raw === 'Unknown Artist') return [{ name: raw || 'Unknown Artist', role: 'primary' }];

  const { primary, featuring } = extractFeaturing(raw);

  let primaryNames: string[];
  if (isKnown(primary, knownArtists)) {
    primaryNames = [primary];
  } else {
    const candidates = splitOnDelimiters(primary);
    if (candidates.length > 1 && candidates.every((c) => isKnown(c, knownArtists))) {
      primaryNames = candidates;
    } else if (candidates.length > 1) {
      primaryNames = candidates;
    } else {
      primaryNames = [primary];
    }
  }

  const result: ArtistCredit[] = primaryNames.map((name) => ({ name, role: 'primary' as const }));

  for (const name of featuring) {
    if (isKnown(name, knownArtists)) {
      result.push({ name, role: 'featuring' });
    } else {
      const subSplit = splitOnDelimiters(name);
      for (const sub of subSplit) {
        result.push({ name: sub, role: 'featuring' });
      }
    }
  }

  return result;
}

export function formatArtistDisplay(artists: ArtistCredit[]): string {
  const primaries = artists.filter((a) => a.role === 'primary');
  const feats = artists.filter((a) => a.role === 'featuring');

  let display = primaries.map((a) => a.name).join(' & ');
  if (feats.length > 0) {
    display += ` feat. ${feats.map((a) => a.name).join(' & ')}`;
  }
  return display;
}
