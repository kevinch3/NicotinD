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
    voteScale: 'binary',
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
          ratingCount: 0,
          meanRating: null,
          ratingCounts: [0, 0, 0, 0, 0],
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
      voteScale: 'binary',
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

describe('stars5 graded agreement (issue #800)', () => {
  function starsDataset(
    seedFeatures: Record<string, unknown>,
    candidates: Array<{ features: Record<string, unknown>; meanRating: number | null }>,
  ): RadioPollExportDataset {
    const base = dataset(
      seedFeatures,
      candidates.map((c) => ({ features: c.features, consensus: null })),
    );
    base.voteScale = 'stars5';
    base.settings.voteScale = 'stars5';
    for (const [i, c] of candidates.entries()) {
      const target = base.scenarios[0]!.candidates[i]!;
      target.meanRating = c.meanRating;
      target.ratingCount = c.meanRating === null ? 0 : 1;
      target.ratingCounts = [0, 0, 0, 0, 0];
    }
    return base;
  }

  const seed = { duration: 200, artistId: 'seed-a', genres: ['Rock'], bpm: 120 };

  it('forms pairs from unequal mean ratings, ordered by the weight set', () => {
    const ds = starsDataset(seed, [
      { features: { duration: 200, artistId: 'x', genres: ['Rock'], bpm: 60 }, meanRating: 5 },
      { features: { duration: 200, artistId: 'y', genres: ['Salsa'], bpm: 120 }, meanRating: 2 },
      { features: { duration: 200, artistId: 'z', genres: ['Jazz'], bpm: 90 }, meanRating: null },
    ]);
    const genreWise = evaluatePollAgreement(ds, onlyAxes({ genre: 18 }));
    expect(genreWise.voteScale).toBe('stars5');
    expect(genreWise.gradedCandidates).toBe(2);
    expect(genreWise.tally.pairs).toBe(1);
    expect(genreWise.auc).toBe(1);
    expect(evaluatePollAgreement(ds, onlyAxes({ bpm: 8 })).auc).toBe(0);
  });

  it('a middling pair binary consensus would have discarded still counts', () => {
    // Two raters split 4/3 vs 3/3 — under thumbs both would tie into ungraded.
    const ds = starsDataset(seed, [
      { features: { duration: 200, artistId: 'x', genres: ['Rock'] }, meanRating: 3.5 },
      { features: { duration: 200, artistId: 'y', genres: ['Salsa'] }, meanRating: 3 },
    ]);
    const r = evaluatePollAgreement(ds, onlyAxes({ genre: 18 }));
    expect(r.tally.pairs).toBe(1);
    expect(r.auc).toBe(1);
  });

  it('equal means contribute no pair; identical scores get half credit', () => {
    const equalMeans = starsDataset(seed, [
      { features: { duration: 200, artistId: 'x', genres: ['Rock'] }, meanRating: 4 },
      { features: { duration: 200, artistId: 'y', genres: ['Salsa'] }, meanRating: 4 },
    ]);
    expect(evaluatePollAgreement(equalMeans).tally.pairs).toBe(0);
    expect(evaluatePollAgreement(equalMeans).auc).toBeNull();

    const sameFeatures = { duration: 200, artistId: 'x', genres: ['Rock'] };
    const scoreTie = starsDataset(seed, [
      { features: sameFeatures, meanRating: 5 },
      { features: { ...sameFeatures, artistId: 'y' }, meanRating: 1 },
    ]);
    expect(evaluatePollAgreement(scoreTie, onlyAxes({ genre: 18 })).auc).toBe(0.5);
  });
});

describe('station (filter) scenarios are measured, not skipped', () => {
  /** A station scenario: no seed song, a centroid, station-graded candidates. */
  function stationDataset(): RadioPollExportDataset {
    const cand = (id: string, affinity: number, consensus: Consensus) => ({
      songId: id,
      title: id,
      artist: id,
      features: { duration: 240, artistId: id, stationAffinity: affinity },
      score: 0,
      rank: 1,
      explanation: { axes: [] },
      up: consensus === 'good' ? 1 : 0,
      down: consensus === 'bad' ? 1 : 0,
      ratingCount: 0,
      meanRating: null,
      ratingCounts: [0, 0, 0, 0, 0],
      consensus,
    });
    return {
      pollId: 'p1',
      name: 'Stations',
      createdAt: 0,
      engineVersion: null,
      formulaVersion: '3',
      voteScale: 'binary',
      settings: { scenarioCount: 1, nextUpCount: 2 },
      raterCount: 1,
      voteCount: 2,
      scenarios: [
        {
          id: 'sc1',
          position: 0,
          kind: 'filter',
          seed: null,
          centroid: { duration: 240, artistId: '', genres: ['Electronic'] },
          filter: { genres: ['Electronic'] },
          weights: {},
          candidates: [cand('native', 1, 'good'), cand('marginal', 0.26, 'bad')],
        },
      ],
    };
  }

  it('grades a station scenario against its centroid', () => {
    // Before this, `evaluatePollAgreement` skipped every seed-less scenario, so
    // a station poll could collect any number of votes and still measure
    // nothing at all.
    const result = evaluatePollAgreement(stationDataset(), DEFAULT_WEIGHTS);
    expect(result.gradedCandidates).toBe(2);
    expect(result.tally.pairs).toBe(1);
    // The rater agreed with the engine: the genre native was the good one.
    expect(result.auc).toBe(1);
  });

  it('still skips a scenario carrying neither a seed nor a centroid', () => {
    const ds = stationDataset();
    delete ds.scenarios[0]!.centroid;
    const result = evaluatePollAgreement(ds, DEFAULT_WEIGHTS);
    expect(result.gradedCandidates).toBe(0);
    expect(result.tally.pairs).toBe(0);
  });
});
