/**
 * A curation decision a human is being asked to make (docs/curator-triage.md).
 *
 * The reporter side already has a closed vocabulary — `TRACK_REPORT_REASONS`,
 * whose docstring argues that a named reason "routes to a specific fix and
 * makes the backlog sortable". This is the resolver-side equivalent: a closed
 * set of decision SHAPES, each carrying the options it affords as data rather
 * than as prose a human must translate into an action.
 */
export const CURATION_CASE_KINDS = [
  /** Which real-world artist or recording is this? */
  'identity',
  /** The data is right — which album/artist should hold it? */
  'placement',
  /** Same recording? Which copy survives? (phase 3) */
  'duplicate',
  /** Only listening settles it. */
  'listen',
  /** A staged destructive list needing one approval. (phase 3) */
  'batch',
] as const;

export type CurationCaseKind = (typeof CURATION_CASE_KINDS)[number];

export function isCurationCaseKind(v: unknown): v is CurationCaseKind {
  return typeof v === 'string' && (CURATION_CASE_KINDS as readonly string[]).includes(v);
}

/** One fact supporting the decision. `href` renders it as a link. */
export interface CaseEvidence {
  label: string;
  value: string;
  href?: string;
}

/**
 * What applying an option actually runs. Every variant maps to an EXISTING
 * mutation service — see `applyCaseEffect`. Phase 1 deliberately has no
 * album-row override variant: an album-row artist write that contradicts the
 * file tag reverts on the next rescan.
 */
export type CaseEffect =
  | { type: 'resolve-only' }
  | {
      type: 'song-metadata';
      songId: string;
      fields: { title?: string; artist?: string; album?: string; albumArtist?: string };
    }
  | { type: 'artist-merge'; mergeInto: string; rawName: string };

export interface CaseOption {
  id: string;
  label: string;
  /** Why this option might be right — rendered under the label. */
  rationale: string;
  effect: CaseEffect;
  destructive?: boolean;
}

export interface CurationCase {
  /** `flag:<id>` in phase 1; `gen:<generator>:<key>` once generators land. */
  id: string;
  kind: CurationCaseKind;
  target: { kind: 'artist' | 'album' | 'song'; id: string; title: string; subtitle: string };
  /** One sentence: the decision owed. */
  question: string;
  evidence: CaseEvidence[];
  options: CaseOption[];
  /** Round ordering. 1 for a flag (a human already judged it worth raising). */
  confidence: number;
  source: 'flag' | 'generated';
}
