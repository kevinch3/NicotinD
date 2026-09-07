import { describe, expect, it } from 'bun:test';
import {
  STRATEGY_IDS,
  VARIETIES,
  isStrategyId,
  strategyForVariety,
  varietyForStrategy,
} from './radio-strategy.js';

describe('strategyForVariety — the complaint → remedy inversion', () => {
  it('"too similar" asks for different, "too different" asks for similar', () => {
    expect(strategyForVariety('too-similar')).toBe('different');
    expect(strategyForVariety('too-different')).toBe('similar');
    expect(strategyForVariety('balanced')).toBe('balanced');
  });

  it('round-trips through varietyForStrategy for every position', () => {
    for (const v of VARIETIES) expect(varietyForStrategy(strategyForVariety(v))).toBe(v);
    for (const s of STRATEGY_IDS) expect(strategyForVariety(varietyForStrategy(s))).toBe(s);
  });

  it('isStrategyId rejects anything outside the registry', () => {
    expect(isStrategyId('balanced')).toBe(true);
    expect(isStrategyId('random')).toBe(false);
    expect(isStrategyId(undefined)).toBe(false);
  });
});
