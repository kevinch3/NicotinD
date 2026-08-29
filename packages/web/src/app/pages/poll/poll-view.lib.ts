import type { PollRating, PublicPollScenario, RadioPollVerdict } from '../../../types/core';

/** Wizard position: the intro screen, a 0-based scenario index, or the thanks screen. */
export type PollStep = 'intro' | number | 'done';

export type PollPageState = 'loading' | 'active' | 'closed' | 'expired' | 'error';

/** One locally held vote: a 1–5 star rating (stars5 polls) or a thumb (binary). */
export type PollVoteValue = RadioPollVerdict | PollRating;

/** One vote in wire shape for POST /votes. */
export interface PollWireVote {
  scenarioId: string;
  candidateSongId: string;
  verdict?: RadioPollVerdict;
  rating?: PollRating;
}

/** Key of one vote in the local vote map. */
export function voteKey(scenarioId: string, candidateId: string): string {
  return `${scenarioId} ${candidateId}`;
}

/** How many of the scenario's candidates the rater has rated — feeds the skip hint. */
export function ratedCount(
  scenario: PublicPollScenario,
  votes: ReadonlyMap<string, PollVoteValue>,
): number {
  return scenario.candidates.filter((c) => votes.has(voteKey(scenario.id, c.id))).length;
}

/** The scenario's votes in wire shape for POST /votes. */
export function votesForScenario(
  scenario: PublicPollScenario,
  votes: ReadonlyMap<string, PollVoteValue>,
): PollWireVote[] {
  const out: PollWireVote[] = [];
  for (const c of scenario.candidates) {
    const value = votes.get(voteKey(scenario.id, c.id));
    if (value === undefined) continue;
    const base = { scenarioId: scenario.id, candidateSongId: c.id };
    out.push(typeof value === 'number' ? { ...base, rating: value } : { ...base, verdict: value });
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
