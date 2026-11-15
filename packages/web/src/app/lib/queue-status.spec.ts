import { describe, expect, it } from 'vitest';
import { formatWait, queueBadgeKey, queueDetail } from './queue-status';

/** Echoes the key and its params, so a spec asserts the wording's inputs, not the English. */
const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}(${Object.values(params).join(',')})` : key;

describe('formatWait (#1938)', () => {
  it('says "under a minute" below a minute, whole minutes from there', () => {
    expect(formatWait(0, t)).toBe('downloads.queue.underMinute');
    expect(formatWait(59_000, t)).toBe('downloads.queue.underMinute');
    expect(formatWait(60_000, t)).toBe('downloads.queue.minutes(1)');
    expect(formatWait(150_000, t)).toBe('downloads.queue.minutes(3)');
  });
});

describe('queueBadgeKey (#1938)', () => {
  it('names each state for the stage badge', () => {
    expect(queueBadgeKey({ state: 'waiting', ahead: 2, etaMs: 0 })).toBe(
      'downloads.queue.state.waiting',
    );
    expect(queueBadgeKey({ state: 'searching', etaMs: 0 })).toBe('downloads.queue.state.searching');
    expect(queueBadgeKey({ state: 'retrying', retryAt: 0 })).toBe('downloads.queue.state.retrying');
  });
});

describe('queueDetail (#1938)', () => {
  it("says how many are ahead and roughly how long, or that it's next", () => {
    expect(queueDetail({ state: 'waiting', ahead: 3, etaMs: 65_000 }, t, 0)).toBe(
      'downloads.queue.ahead(3) · downloads.queue.minutes(1)',
    );
    expect(queueDetail({ state: 'waiting', ahead: 0, etaMs: 5_000 }, t, 0)).toBe(
      'downloads.queue.next · downloads.queue.underMinute',
    );
  });

  it('counts down to a retry, never below zero', () => {
    expect(queueDetail({ state: 'retrying', retryAt: 130_000 }, t, 10_000)).toBe(
      'downloads.queue.retryIn(downloads.queue.minutes(2))',
    );
    expect(queueDetail({ state: 'retrying', retryAt: 0 }, t, 10_000)).toBe(
      'downloads.queue.retryIn(downloads.queue.underMinute)',
    );
  });

  it('adds nothing to a running search: the badge already says it', () => {
    expect(queueDetail({ state: 'searching', etaMs: 10_000 }, t, 0)).toBeNull();
  });
});
