/**
 * Named recommendation strategies — the whole recipe for one radio generation,
 * chosen by name. The client's variety control, `dump-radio --strategy` and the
 * poll harness all select from this one registry, so a "different" the listener
 * asked for is the same "different" the harness measures.
 *
 * Why pool composition and a quota rather than a rank-window sampler: on prod
 * the random pool draw already moves 6–9 of the served 10 while a weight A/B
 * moves 0–3 (docs/radio.md, #598). "Too different" served by sampling lower
 * ranks would be *worse* tracks from the same genre pool — more of the same.
 * What makes `different` different is an out-of-genre pool pass plus a
 * deterministic share of the served window reserved for its best rows, so the
 * effect is guaranteed and measurable in one dump line.
 *
 * `balanced` is pinned to the literals the pool used before strategies existed
 * (a test asserts it), so the formula's poll comparability holds: a strategy is
 * a weight set + a pool, never a new scoring function. `RADIO_FORMULA_VERSION`
 * stays; the strategy id travels as its own field on a poll scenario.
 */
import { DEFAULT_STRATEGY, isStrategyId, type StrategyId } from '@nicotind/core';
import { DEFAULT_WEIGHTS, type ScoringWeights } from '../radio.service.js';
import type { ReadinessTier } from './eligibility.js';

/** `LIMIT`s of the seed/list pool passes, in pass order. 0 skips a pass. */
export interface PoolMix {
  /** Pass 1: shares any genre with the seed. */
  anyGenre: number;
  /** Pass 1b: genre-variant match on the seed's longest token. */
  genreToken: number;
  /** Pass 2: bpm ±15 %. */
  bpm: number;
  /** Pass 3: energy ±0.15. */
  energy: number;
  /** Pass 4: shares NO genre with the seed (the "different" lever). */
  outOfGenre: number;
  /** Pass 5 runs only while the pool is below this; also the tier-2 trigger. */
  backfillBelow: number;
  /** Pass 5: random backfill. */
  backfill: number;
}

export interface RecommendationStrategy {
  id: StrategyId;
  /** Overrides onto `DEFAULT_WEIGHTS`; `{}` is the formula as shipped. */
  weights: Partial<ScoringWeights>;
  maxPerArtist: number;
  poolMix: PoolMix;
  /** Share of the served window (0..1) reserved for the best out-of-genre rows. */
  outOfGenreQuota: number;
  readinessTier: ReadinessTier;
}

/** The pool exactly as it was before strategies (radio.md "Candidate pool construction"). */
export const BALANCED_POOL_MIX: PoolMix = {
  anyGenre: 150,
  genreToken: 100,
  bpm: 100,
  energy: 100,
  outOfGenre: 0,
  backfillBelow: 50,
  backfill: 100,
};

export const STRATEGIES: Record<StrategyId, RecommendationStrategy> = {
  balanced: {
    id: 'balanced',
    weights: {},
    maxPerArtist: 2,
    poolMix: BALANCED_POOL_MIX,
    outOfGenreQuota: 0,
    readinessTier: 1,
  },
  // Tighter to the seed: a bigger same-genre pool, no random top-up, the
  // identity axes (genre, embedding, timbre) heavier, a third slot per artist.
  similar: {
    id: 'similar',
    weights: {
      genre: DEFAULT_WEIGHTS.genre + 6,
      embedding: DEFAULT_WEIGHTS.embedding * 1.5,
      timbre: DEFAULT_WEIGHTS.timbre * 1.5,
      bpm: DEFAULT_WEIGHTS.bpm + 2,
    },
    maxPerArtist: 3,
    poolMix: {
      ...BALANCED_POOL_MIX,
      anyGenre: 250,
      genreToken: 50,
      backfillBelow: 30,
      backfill: 0,
    },
    outOfGenreQuota: 0,
    readinessTier: 1,
  },
  // Wider: genre and origin count for less, the embedding half as much, one
  // slot per artist, an out-of-genre pass, and 30 % of the window reserved for
  // its best rows so the widening is guaranteed rather than probable.
  different: {
    id: 'different',
    weights: {
      genre: 8,
      origin: 4,
      embedding: DEFAULT_WEIGHTS.embedding * 0.5,
      artistPenalty: DEFAULT_WEIGHTS.artistPenalty * 1.5,
    },
    maxPerArtist: 1,
    poolMix: { ...BALANCED_POOL_MIX, anyGenre: 80, genreToken: 50, outOfGenre: 120 },
    outOfGenreQuota: 0.3,
    readinessTier: 1,
  },
};

export class UnknownStrategyError extends Error {
  constructor(id: string) {
    super(`unknown recommendation strategy: ${id}`);
    this.name = 'UnknownStrategyError';
  }
}

/** Absent → the default; unknown → throws, so a route can answer 400 rather than guess. */
export function resolveStrategy(id: string | undefined | null): RecommendationStrategy {
  if (id === undefined || id === null || id === '') return STRATEGIES[DEFAULT_STRATEGY];
  if (!isStrategyId(id)) throw new UnknownStrategyError(id);
  return STRATEGIES[id];
}

export function resolveWeights(s: RecommendationStrategy): ScoringWeights {
  return { ...DEFAULT_WEIGHTS, ...s.weights };
}
