import { describe, expect, it } from 'bun:test';
import { STRATEGY_IDS } from '@nicotind/core';
import { DEFAULT_WEIGHTS } from '../radio.service.js';
import {
  BALANCED_POOL_MIX,
  STRATEGIES,
  UnknownStrategyError,
  resolveStrategy,
  resolveWeights,
} from './strategies.js';

describe('STRATEGIES', () => {
  it('balanced is pinned to the pre-strategy pool and the shipped formula', () => {
    const b = STRATEGIES.balanced;
    expect(b.weights).toEqual({});
    expect(resolveWeights(b)).toEqual(DEFAULT_WEIGHTS);
    expect(b.maxPerArtist).toBe(2);
    expect(b.outOfGenreQuota).toBe(0);
    expect(b.poolMix).toEqual({
      anyGenre: 150,
      genreToken: 100,
      bpm: 100,
      energy: 100,
      outOfGenre: 0,
      backfillBelow: 50,
      backfill: 100,
    });
    expect(BALANCED_POOL_MIX).toBe(b.poolMix);
  });

  it('every id in the shared vocabulary resolves to a strategy of the same id', () => {
    for (const id of STRATEGY_IDS) expect(resolveStrategy(id).id).toBe(id);
    expect(resolveStrategy(undefined).id).toBe('balanced');
    expect(resolveStrategy('').id).toBe('balanced');
  });

  it('an unknown id throws rather than silently falling back', () => {
    expect(() => resolveStrategy('random')).toThrow(UnknownStrategyError);
  });

  it('similar tightens and different widens, in the directions the names promise', () => {
    const s = resolveWeights(STRATEGIES.similar);
    const d = resolveWeights(STRATEGIES.different);
    expect(s.genre).toBeGreaterThan(DEFAULT_WEIGHTS.genre);
    expect(d.genre).toBeLessThan(DEFAULT_WEIGHTS.genre);
    expect(s.embedding).toBeGreaterThan(d.embedding);
    expect(STRATEGIES.similar.maxPerArtist).toBeGreaterThan(STRATEGIES.different.maxPerArtist);
    expect(STRATEGIES.similar.poolMix.backfill).toBe(0);
    expect(STRATEGIES.different.poolMix.outOfGenre).toBeGreaterThan(0);
    expect(STRATEGIES.different.outOfGenreQuota).toBeGreaterThan(0);
    expect(STRATEGIES.similar.outOfGenreQuota).toBe(0);
  });
});
