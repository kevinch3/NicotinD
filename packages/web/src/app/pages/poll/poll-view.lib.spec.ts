import { describe, expect, it } from 'vitest';
import type { PublicPollScenario } from '../../../types/core';
import {
  nextStep,
  pollFailureState,
  prevStep,
  scenarioComplete,
  voteKey,
  votesForScenario,
} from './poll-view.lib';

function scenario(id = 'sc1', candidateIds = ['c1', 'c2']): PublicPollScenario {
  return {
    id,
    position: 0,
    seed: { id: 'seed', title: 'S', artist: 'A', album: 'Al', coverArt: 'seed', duration: 100 },
    candidates: candidateIds.map((cid) => ({
      id: cid,
      title: `T ${cid}`,
      artist: 'A',
      album: 'Al',
      coverArt: cid,
      duration: 100,
    })),
  };
}

describe('scenarioComplete', () => {
  it('is true only once every candidate has a verdict', () => {
    const sc = scenario();
    const votes = new Map<string, 'up' | 'down'>([[voteKey('sc1', 'c1'), 'up']]);
    expect(scenarioComplete(sc, votes)).toBe(false);
    votes.set(voteKey('sc1', 'c2'), 'down');
    expect(scenarioComplete(sc, votes)).toBe(true);
  });

  it('ignores votes from other scenarios', () => {
    const votes = new Map([
      [voteKey('other', 'c1'), 'up' as const],
      [voteKey('other', 'c2'), 'up' as const],
    ]);
    expect(scenarioComplete(scenario(), votes)).toBe(false);
  });
});

describe('votesForScenario', () => {
  it('emits wire-shaped votes for the scenario only', () => {
    const votes = new Map([
      [voteKey('sc1', 'c1'), 'up' as const],
      [voteKey('sc1', 'c2'), 'down' as const],
      [voteKey('other', 'c9'), 'up' as const],
    ]);
    expect(votesForScenario(scenario(), votes)).toEqual([
      { scenarioId: 'sc1', candidateSongId: 'c1', verdict: 'up' },
      { scenarioId: 'sc1', candidateSongId: 'c2', verdict: 'down' },
    ]);
  });
});

describe('pollFailureState', () => {
  it('maps 410 codes onto closed/expired and everything else onto error', () => {
    expect(pollFailureState({ status: 410, error: { code: 'POLL_CLOSED' } })).toBe('closed');
    expect(pollFailureState({ status: 410, error: { code: 'POLL_EXPIRED' } })).toBe('expired');
    expect(pollFailureState({ status: 410 })).toBe('closed');
    expect(pollFailureState({ status: 404 })).toBe('error');
    expect(pollFailureState({})).toBe('error');
  });
});

describe('nextStep / prevStep', () => {
  it('walks intro → 0..n-1 → done', () => {
    expect(nextStep('intro', 2)).toBe(0);
    expect(nextStep(0, 2)).toBe(1);
    expect(nextStep(1, 2)).toBe('done');
    expect(nextStep('done', 2)).toBe('done');
  });

  it('intro with zero scenarios goes straight to done', () => {
    expect(nextStep('intro', 0)).toBe('done');
  });

  it('prevStep returns to intro from the first scenario and clamps at the edges', () => {
    expect(prevStep(1)).toBe(0);
    expect(prevStep(0)).toBe('intro');
    expect(prevStep('intro')).toBe('intro');
    expect(prevStep('done')).toBe('done');
  });
});
