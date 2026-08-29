import { describe, expect, it } from 'bun:test';
import { planTitleNormalization, shouldStopAfterFailures } from './normalize-titles.js';

describe('planTitleNormalization', () => {
  it('proposes a change only for rows the cleaner actually rewrites', () => {
    const plan = planTitleNormalization([
      { id: 's1', text: 'Pegao (Official Video)' },
      { id: 's2', text: 'Dancing Thing' },
      { id: 's3', text: 'Help! - Remastered 2009' },
    ]);
    expect(plan).toEqual([
      { id: 's1', from: 'Pegao (Official Video)', to: 'Pegao', removed: ['(Official Video)'] },
      { id: 's3', from: 'Help! - Remastered 2009', to: 'Help!', removed: ['- Remastered 2009'] },
    ]);
  });

  it('is idempotent — a second pass over its own output proposes nothing', () => {
    const first = planTitleNormalization([{ id: 's1', text: 'Pegao (Official Video)' }]);
    const second = planTitleNormalization(first.map((c) => ({ id: c.id, text: c.to })));
    expect(second).toEqual([]);
  });

  it('never proposes an empty title', () => {
    expect(planTitleNormalization([{ id: 's1', text: '(Official Video)' }])).toEqual([]);
  });

  it('leaves the Evanescence variants that only their suffix distinguishes', () => {
    const plan = planTitleNormalization([
      { id: 'a', text: 'Bring Me To Life - Demo / Remastered 2023' },
      { id: 'b', text: 'Bring Me To Life - AOL Session / 2003 / Remastered' },
    ]);
    expect(plan).toEqual([]);
  });
});

// Both halves of the breaker are load-bearing, so each is pinned on its own:
// the floor is what keeps a good long run alive through scattered failures,
// the ratio is what catches a systematic veto like #776's pinned tracklists.
describe('shouldStopAfterFailures', () => {
  it('does not stop while failures are below the floor, however bad the ratio', () => {
    // 4 for 4 — every write failing, but far too early to call it systematic.
    expect(shouldStopAfterFailures(4, 4)).toBe(false);
  });

  it('does not stop on scattered failures in a long run', () => {
    // 40 failures is a lot in absolute terms and still a minority of 200.
    expect(shouldStopAfterFailures(40, 200)).toBe(false);
  });

  it('stops once a majority of a meaningful number of attempts is failing', () => {
    expect(shouldStopAfterFailures(5, 9)).toBe(true);
  });

  it('stops promptly when every write is failing — the #776 shape', () => {
    expect(shouldStopAfterFailures(5, 5)).toBe(true);
  });

  it('needs a strict majority, so an exact half keeps going', () => {
    expect(shouldStopAfterFailures(5, 10)).toBe(false);
  });
});
