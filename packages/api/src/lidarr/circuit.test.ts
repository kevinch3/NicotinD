import { describe, expect, it } from 'bun:test';
import { LidarrCircuit } from './circuit.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function circuit(c = clock()) {
  return new LidarrCircuit({
    threshold: 3,
    baseCooldownMs: 60_000,
    maxCooldownMs: 240_000,
    now: c.now,
  });
}

describe('LidarrCircuit', () => {
  it('stays closed below the failure threshold', () => {
    const cb = circuit();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen).toBe(false);
    expect(cb.admit()).toBe(true);
  });

  it('opens after consecutive failures and refuses background calls during the cool-down', () => {
    const c = clock();
    const cb = circuit(c);
    for (let i = 0; i < 3; i++) cb.recordFailure();
    expect(cb.isOpen).toBe(true);
    expect(cb.admit()).toBe(false);
    c.advance(59_999);
    expect(cb.admit()).toBe(false);
    expect(cb.probeDue).toBe(false);
  });

  it('counts only consecutive failures — an answer in between resets the run', () => {
    const cb = circuit();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen).toBe(false);
  });

  it('lets exactly one probe through once the cool-down ends', () => {
    const c = clock();
    const cb = circuit(c);
    for (let i = 0; i < 3; i++) cb.recordFailure();
    c.advance(60_000);
    expect(cb.probeDue).toBe(true);
    expect(cb.admit()).toBe(true);
    expect(cb.probeDue).toBe(false);
    expect(cb.admit()).toBe(false);
  });

  it('closes when the probe is answered', () => {
    const c = clock();
    const cb = circuit(c);
    for (let i = 0; i < 3; i++) cb.recordFailure();
    c.advance(60_000);
    cb.admit();
    cb.recordSuccess();
    expect(cb.isOpen).toBe(false);
    expect(cb.admit()).toBe(true);
  });

  it('doubles the cool-down on each failed probe, up to the cap', () => {
    const c = clock();
    const cb = circuit(c);
    for (let i = 0; i < 3; i++) cb.recordFailure();
    const cooldowns: number[] = [];
    let waited = 60_000;
    for (let round = 0; round < 4; round++) {
      c.advance(waited);
      expect(cb.admit()).toBe(true);
      cb.recordFailure();
      // Find the new cool-down by stepping until the next probe is due.
      let step = 0;
      while (!cb.probeDue) {
        c.advance(1_000);
        step += 1_000;
      }
      cooldowns.push(step);
      waited = 0;
    }
    expect(cooldowns).toEqual([120_000, 240_000, 240_000, 240_000]);
  });

  it('stays open (background paused) after the cool-down until something succeeds', () => {
    const c = clock();
    const cb = circuit(c);
    for (let i = 0; i < 3; i++) cb.recordFailure();
    c.advance(10 * 60_000);
    expect(cb.isOpen).toBe(true);
  });

  it('remembers when Lidarr last failed', () => {
    const c = clock(5_000);
    const cb = circuit(c);
    expect(cb.lastFailureAt).toBeNull();
    cb.recordFailure();
    expect(cb.lastFailureAt).toBe(5_000);
  });
});
