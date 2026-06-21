/**
 * Friction / step-count model for playground flows — the harness's measure of
 * how *clunky* a user journey is, independent of whether it eventually works.
 *
 * A flow drives the real UI and calls `step()` for each discrete user action,
 * `fallback()` when an expected affordance was missing and a workaround was
 * needed, and `deadEnd()` when the journey couldn't proceed. `summarize()` turns
 * the tally into observations: a step-count metric, a `gap` per dead-end, and an
 * `enhancement` per fallback. Pure (no Playwright) so it's unit-tested in CI; the
 * fixture binds an instance to the recorder.
 */
import type { Observation } from './observe.js';

export type Outcome = 'success' | 'partial' | 'degraded' | 'failed';

/** Stable title the report's Outcome matrix scans for. */
export const OUTCOME_TITLE = 'Outcome';

export class Journey {
  private steps: string[] = [];
  private fallbacks: string[] = [];
  private deadEnds: string[] = [];

  constructor(public readonly flow: string) {}

  /** Record a discrete user action (a click, a navigation, a form submit). */
  step(label: string): this {
    this.steps.push(label);
    return this;
  }

  /** A primary affordance was missing; a workaround was used. Friction signal. */
  fallback(label: string): this {
    this.fallbacks.push(label);
    return this;
  }

  /** The journey could not proceed here — a dead-end the user would hit. */
  deadEnd(label: string): this {
    this.deadEnds.push(label);
    return this;
  }

  get stepCount(): number {
    return this.steps.length;
  }

  /** Observations describing the journey's friction. */
  summarize(): Observation[] {
    const out: Observation[] = [];
    out.push({
      flow: this.flow,
      kind: 'metric',
      title: 'Steps to complete',
      value: this.steps.length,
      unit: 'count',
      severity: 'info',
      detail: this.steps.length ? this.steps.join(' → ') : undefined,
    });
    for (const f of this.fallbacks) {
      out.push({
        flow: this.flow,
        kind: 'enhancement',
        title: `Fallback needed: ${f}`,
        severity: 'medium',
        suggestion:
          'A primary affordance was missing or unstable; the flow used a workaround. ' +
          'Add/repair the expected control (data-testid) to remove friction.',
      });
    }
    for (const d of this.deadEnds) {
      out.push({
        flow: this.flow,
        kind: 'gap',
        title: `Dead-end: ${d}`,
        severity: 'high',
        suggestion: 'The journey could not proceed here — a user would be stuck.',
      });
    }
    return out;
  }
}

/** A terminal success measurement for a flow — feeds the report Outcome matrix. */
export function outcomeObservation(flow: string, outcome: Outcome, detail?: string): Observation {
  const severity: Observation['severity'] =
    outcome === 'failed' ? 'high' : outcome === 'partial' || outcome === 'degraded' ? 'low' : 'info';
  return { flow, kind: 'metric', title: OUTCOME_TITLE, value: outcome, severity, detail };
}
