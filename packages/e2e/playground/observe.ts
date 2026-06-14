/**
 * Playground observation model — the unit of "feedback" the harness gathers.
 *
 * A playground flow doesn't (mostly) assert pass/fail; it *records observations*
 * — timings, result counts, dead-ends, gaps, enhancement ideas — that the custom
 * reporter (`reporter.ts`) aggregates into a markdown + JSON findings report. This
 * is the automated equivalent of the hand-written `docs/e2e-playground-findings-*`
 * sessions.
 *
 * This module is **pure** (no Playwright import) so the encode/decode + summary
 * logic is unit-testable under `bun test` and runs in CI, while the Playwright
 * specs that produce observations stay gated out of CI (they need a live backend).
 */

export type ObservationKind =
  | 'metric' // a measured value (count, ratio)
  | 'timing' // a latency measurement
  | 'gap' // a missing capability / UX dead-end
  | 'enhancement' // an improvement opportunity (works, but could be better)
  | 'degraded' // a flow that couldn't run fully (backend unavailable) — not a failure
  | 'error'; // an unexpected failure while gathering feedback

export type Severity = 'info' | 'low' | 'medium' | 'high';

export interface Observation {
  /** Flow that produced this, e.g. "song-acquisition (§F)". */
  flow: string;
  kind: ObservationKind;
  /** Short headline, stable across runs so the report diffs cleanly. */
  title: string;
  /** Optional longer context (a URL, a sample value, a reason). */
  detail?: string;
  /** Measured value for metric/timing kinds. */
  value?: number | string;
  /** Unit for `value` — "ms", "count", "%", etc. */
  unit?: string;
  severity: Severity;
  /** What to do about it — surfaced in the report's recommendations. */
  suggestion?: string;
}

/** Playwright annotation `type` used to smuggle observations to the reporter. */
export const ANNOTATION_TYPE = 'playground.observation';

const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1, info: 0 };

export function severityRank(s: Severity): number {
  return SEVERITY_RANK[s] ?? 0;
}

export function encodeObservation(o: Observation): string {
  return JSON.stringify(o);
}

export function decodeObservation(s: string): Observation | null {
  try {
    const o = JSON.parse(s) as Partial<Observation>;
    if (o && typeof o.flow === 'string' && typeof o.title === 'string' && typeof o.kind === 'string') {
      return {
        flow: o.flow,
        kind: o.kind as ObservationKind,
        title: o.title,
        detail: o.detail,
        value: o.value,
        unit: o.unit,
        severity: (o.severity ?? 'info') as Severity,
        suggestion: o.suggestion,
      };
    }
  } catch {
    // not an observation annotation — ignore
  }
  return null;
}

export interface ObservationSummary {
  total: number;
  byKind: Record<ObservationKind, number>;
  bySeverity: Record<Severity, number>;
  flows: string[];
}

const KINDS: ObservationKind[] = ['metric', 'timing', 'gap', 'enhancement', 'degraded', 'error'];
const SEVERITIES: Severity[] = ['high', 'medium', 'low', 'info'];

export function summarize(observations: Observation[]): ObservationSummary {
  const byKind = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<ObservationKind, number>;
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  const flows = new Set<string>();
  for (const o of observations) {
    byKind[o.kind] = (byKind[o.kind] ?? 0) + 1;
    bySeverity[o.severity] = (bySeverity[o.severity] ?? 0) + 1;
    flows.add(o.flow);
  }
  return { total: observations.length, byKind, bySeverity, flows: [...flows].sort() };
}

/** Stable sort: most severe first, then gaps/enhancements before metrics. */
const KIND_RANK: Record<ObservationKind, number> = {
  error: 5,
  gap: 4,
  enhancement: 3,
  degraded: 2,
  timing: 1,
  metric: 0,
};

export function sortObservations(observations: Observation[]): Observation[] {
  return [...observations].sort((a, b) => {
    const s = severityRank(b.severity) - severityRank(a.severity);
    if (s !== 0) return s;
    return KIND_RANK[b.kind] - KIND_RANK[a.kind];
  });
}
