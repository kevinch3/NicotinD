import { describe, expect, it } from 'bun:test';
import { DEFAULT_WEIGHTS, type ScoringWeights } from './radio.service.js';
import {
  agreementAuc,
  evaluatePollAgreement,
  pooledTally,
  type PollAgreement,
} from './radio-poll-eval.js';
import type { RadioPollExportDataset } from './radio-poll-export.js';

type Consensus = 'good' | 'bad' | null;

function dataset(
  seedFeatures: Record<string, unknown>,
  candidates: Array<{
    features: Record<string, unknown>;
    explanation?: unknown;
    consensus: Consensus;
  }>,
): RadioPollExportDataset {
  return {
    pollId: 'p1',
    name: 'P',
    createdAt: 0,
    engineVersion: null,
    formulaVersion: '1',
    settings: { scenarioCount: 1, nextUpCount: candidates.length },
    raterCount: 1,
    voteCount: candidates.length,
    scenarios: [
      {
        id: 'sc1',
        position: 0,
        kind: 'seed',
        seed: { songId: 'seed', title: 'S', artist: 'A', features: seedFeatures },
        weights: {},
        candidates: candidates.map((c, i) => ({
          songId: `c${i}`,
          title: `C${i}`,
          artist: `AC${i}`,
          features: c.features,
          score: 0,
          rank: i + 1,
          explanation: c.explanation ?? { axes: [] },
          up: c.consensus === 'good' ? 1 : 0,
          down: c.consensus === 'bad' ? 1 : 0,
          consensus: c.consensus,
        })),
      },
    ],
  };
}

/** Every axis zeroed except the named ones. */
function onlyAxes(overrides: Partial<ScoringWeights>): ScoringWeights {
  const zeroed = Object.fromEntries(
    Object.keys(DEFAULT_WEIGHTS).map((k) => [k, 0]),
  ) as unknown as ScoringWeights;
  return { ...zeroed, ...overrides };
}

describe('evaluatePollAgreement (issue #583)', () => {
  const seed = { duration: 200, artistId: 'seed-a', genres: ['Rock'], bpm: 120 };

  it('recomputes axis values from frozen features — the weight set decides the order', () => {
    const ds = dataset(seed, [
      // genre-right but bpm-far
      { features: { duration: 200, artistId: 'x', genres: ['Rock'], bpm: 60 }, consensus: 'good' },
      // genre-wrong but bpm-exact
      { features: { duration: 200, artistId: 'y', genres: ['Salsa'], bpm: 120 }, consensus: 'bad' },
    ]);
    expect(evaluatePollAgreement(ds, onlyAxes({ genre: 18 })).auc).toBe(1);
    expect(evaluatePollAgreement(ds, onlyAxes({ bpm: 8 })).auc).toBe(0);
    expect(evaluatePollAgreement(ds).tally.pairs).toBe(1);
  });

  it('folds the FROZEN embedding value in (the vector is stripped from snapshots)', () => {
    const feats = { duration: 200, artistId: 'x', genres: ['Rock'] };
    const ds = dataset(seed, [
      {
        features: feats,
        explanation: { axes: [{ axis: 'embedding', value: 0.9, weight: 4, contribution: 3.6 }] },
        consensus: 'good',
      },
      {
        features: { ...feats, artistId: 'y' },
        explanation: { axes: [{ axis: 'embedding', value: 0.1, weight: 4, contribution: 0.4 }] },
        consensus: 'bad',
      },
    ]);
    expect(evaluatePollAgreement(ds, onlyAxes({ embedding: 8 })).auc).toBe(1);
    // With embedding weighted 0 the two candidates are identical → tie = 0.5.
    expect(evaluatePollAgreement(ds, onlyAxes({ genre: 18 })).auc).toBe(0.5);
  });

  it('junk-genre recompute demotes an "Other"="Other"-matched candidate below a real match', () => {
    const junkSeed = { duration: 200, artistId: 'seed-a', genres: ['Reggae'] };
    const ds = dataset(junkSeed, [
      { features: { duration: 200, artistId: 'x', genres: ['Reggae'] }, consensus: 'good' },
      // Frozen v1 explanation said genre=1.0; the recompute must ignore it.
      {
        features: { duration: 200, artistId: 'y', genres: ['Other'] },
        explanation: { axes: [{ axis: 'genre', value: 1, weight: 18, contribution: 18 }] },
        consensus: 'bad',
      },
    ]);
    expect(evaluatePollAgreement(ds, onlyAxes({ genre: 18 })).auc).toBe(1);
  });

  it('ungraded candidates contribute no pairs; empty grading → null auc', () => {
    const ds = dataset(seed, [
      { features: { duration: 200, artistId: 'x', genres: ['Rock'] }, consensus: 'good' },
      { features: { duration: 200, artistId: 'y', genres: ['Salsa'] }, consensus: null },
    ]);
    const r = evaluatePollAgreement(ds);
    expect(r.tally.pairs).toBe(0);
    expect(r.auc).toBeNull();
    expect(r.gradedCandidates).toBe(1);
  });

  it('pooledTally sums tallies across polls', () => {
    const mk = (wins: number, pairs: number): PollAgreement => ({
      pollId: 'p',
      name: 'n',
      formulaVersion: '1',
      scenarioCount: 1,
      gradedCandidates: 2,
      tally: { wins, ties: 0, pairs },
      auc: null,
    });
    const pooled = pooledTally([mk(1, 2), mk(3, 4)]);
    expect(pooled).toEqual({ wins: 4, ties: 0, pairs: 6 });
    expect(agreementAuc(pooled)).toBeCloseTo(4 / 6, 10);
  });
});
