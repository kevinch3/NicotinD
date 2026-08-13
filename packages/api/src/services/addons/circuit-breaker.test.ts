import { describe, expect, it } from 'bun:test';
import { AddonCircuitBreaker } from './circuit-breaker.js';

function make(threshold = 3) {
  const trips: { id: string; reason: string }[] = [];
  const breaker = new AddonCircuitBreaker({
    threshold,
    onTrip: (id, reason) => trips.push({ id, reason }),
  });
  return { breaker, trips };
}

describe('AddonCircuitBreaker', () => {
  it('trips after `threshold` contract violations', () => {
    const { breaker, trips } = make(3);
    breaker.record('a', 'contract-violation');
    breaker.record('a', 'contract-violation');
    expect(trips).toHaveLength(0);
    breaker.record('a', 'contract-violation');
    expect(trips).toHaveLength(1);
    expect(trips[0]!.id).toBe('a');
    expect(breaker.isTripped('a')).toBe(true);
  });

  it('a clean call resets the streak', () => {
    const { breaker, trips } = make(3);
    breaker.record('a', 'contract-violation');
    breaker.record('a', 'contract-violation');
    breaker.record('a', 'ok'); // reset
    breaker.record('a', 'contract-violation');
    breaker.record('a', 'contract-violation');
    expect(trips).toHaveLength(0); // only 2 since the reset
    breaker.record('a', 'contract-violation');
    expect(trips).toHaveLength(1);
  });

  it('transient failures never count and never reset', () => {
    const { breaker, trips } = make(3);
    breaker.record('a', 'contract-violation');
    breaker.record('a', 'transient'); // neutral
    breaker.record('a', 'transient');
    breaker.record('a', 'contract-violation');
    breaker.record('a', 'contract-violation');
    expect(trips).toHaveLength(1); // the 3 violations still tripped
  });

  it('trips only once; further calls on a tripped addon are ignored', () => {
    const { breaker, trips } = make(2);
    breaker.record('a', 'contract-violation');
    breaker.record('a', 'contract-violation'); // trip
    breaker.record('a', 'contract-violation');
    breaker.record('a', 'contract-violation');
    expect(trips).toHaveLength(1);
  });

  it('tracks addons independently', () => {
    const { breaker, trips } = make(2);
    breaker.record('a', 'contract-violation');
    breaker.record('b', 'contract-violation');
    expect(trips).toHaveLength(0);
    breaker.record('a', 'contract-violation'); // a trips
    expect(trips.map((t) => t.id)).toEqual(['a']);
    expect(breaker.isTripped('b')).toBe(false);
  });

  it('reset() clears a tripped addon so it can be re-enabled', () => {
    const { breaker, trips } = make(2);
    breaker.record('a', 'contract-violation');
    breaker.record('a', 'contract-violation');
    breaker.reset('a');
    expect(breaker.isTripped('a')).toBe(false);
    breaker.record('a', 'contract-violation');
    breaker.record('a', 'contract-violation');
    expect(trips).toHaveLength(2); // tripped again after reset
  });
});
