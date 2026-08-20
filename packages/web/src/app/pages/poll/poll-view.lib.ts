import type { PublicPollScenario, RadioPollVerdict } from '../../../types/core';

/** Wizard position: the intro screen, a 0-based scenario index, or the thanks screen. */
export type PollStep = 'intro' | number | 'done';

export type PollPageState = 'loading' | 'active' | 'closed' | 'expired' | 'error';

/** Key of one vote in the local vote map. */
export function voteKey(scenarioId: string, candidateId: string): string {
  return `${scenarioId} ${candidateId}`;
}

/** True once every candidate in the scenario has a verdict — gates "Next". */
export function scenarioComplete(
  scenario: PublicPollScenario,
  votes: ReadonlyMap<string, RadioPollVerdict>,
): boolean {
  return scenario.candidates.every((c) => votes.has(voteKey(scenario.id, c.id)));
}

/** The scenario's votes in wire shape for POST /votes. */
export function votesForScenario(
  scenario: PublicPollScenario,
  votes: ReadonlyMap<string, RadioPollVerdict>,
): Array<{ scenarioId: string; candidateSongId: string; verdict: RadioPollVerdict }> {
  const out: Array<{ scenarioId: string; candidateSongId: string; verdict: RadioPollVerdict }> = [];
  for (const c of scenario.candidates) {
    const verdict = votes.get(voteKey(scenario.id, c.id));
    if (verdict) out.push({ scenarioId: scenario.id, candidateSongId: c.id, verdict });
  }
  return out;
}

/** Map a failed poll fetch onto a page state the template can explain. */
export function pollFailureState(err: {
  status?: number;
  error?: { code?: string };
}): PollPageState {
  if (err.status === 410) {
    return err.error?.code === 'POLL_EXPIRED' ? 'expired' : 'closed';
  }
  return 'error';
}

/** Next wizard step after `current` for a poll of `scenarioCount` scenarios. */
export function nextStep(current: PollStep, scenarioCount: number): PollStep {
  if (current === 'intro') return scenarioCount > 0 ? 0 : 'done';
  if (current === 'done') return 'done';
  return current + 1 >= scenarioCount ? 'done' : current + 1;
}

/** Previous wizard step (never leaves the scenario range back into intro-less states). */
export function prevStep(current: PollStep): PollStep {
  if (current === 'intro' || current === 'done') return current;
  return current === 0 ? 'intro' : current - 1;
}
