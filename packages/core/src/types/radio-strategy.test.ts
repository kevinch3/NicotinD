import { describe, expect, it } from 'bun:test';
import {
  STRATEGY_IDS,
  VARIETIES,
  isStrategyId,
  strategyForVariety,
  varietyForStrategy,
} from './radio-strategy.js';

describe('strategyForVariety — the Close · Medium · Far dial (#1660)', () => {
  it('the dial is monotone: left to right is closer to farther, in STRATEGY_IDS order', () => {
    expect(VARIETIES.map(strategyForVariety)).toEqual(['similar', 'balanced', 'different']);
    expect(VARIETIES.map(strategyForVariety)).toEqual([...STRATEGY_IDS]);
    expect(strategyForVariety('close')).toBe('similar');
    expect(strategyForVariety('medium')).toBe('balanced');
    expect(strategyForVariety('far')).toBe('different');
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
