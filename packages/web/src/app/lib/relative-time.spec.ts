import { describe, it, expect, vi } from 'vitest';
import { relativeBucket, timeAgo, RELATIVE_TIME_KEYS } from './relative-time';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('relativeBucket', () => {
  it('buckets by the boundary, not near it', () => {
    expect(relativeBucket(NOW, NOW)).toEqual({ unit: 'now' });
    expect(relativeBucket(NOW - 59_999, NOW)).toEqual({ unit: 'now' });
    expect(relativeBucket(NOW - MIN, NOW)).toEqual({ unit: 'minutes', value: 1 });
    expect(relativeBucket(NOW - 59 * MIN, NOW)).toEqual({ unit: 'minutes', value: 59 });
    expect(relativeBucket(NOW - HOUR, NOW)).toEqual({ unit: 'hours', value: 1 });
    expect(relativeBucket(NOW - 23 * HOUR, NOW)).toEqual({ unit: 'hours', value: 23 });
    expect(relativeBucket(NOW - DAY, NOW)).toEqual({ unit: 'yesterday' });
    expect(relativeBucket(NOW - 2 * DAY, NOW)).toEqual({ unit: 'days', value: 2 });
  });

  it('clamps a future timestamp to "now" instead of counting backwards', () => {
    // last_seen_at is stamped server-side; a browser clock a few seconds behind
    // would otherwise render "-1m ago".
    expect(relativeBucket(NOW + 5 * MIN, NOW)).toEqual({ unit: 'now' });
  });
});

describe('timeAgo', () => {
  it('returns the original English wording with no translator', () => {
    // The Downloads feed calls it this way; the extraction must not change a byte.
    expect(timeAgo(NOW, undefined, NOW)).toBe('Just now');
    expect(timeAgo(NOW - 5 * MIN, undefined, NOW)).toBe('5m ago');
    expect(timeAgo(NOW - 3 * HOUR, undefined, NOW)).toBe('3h ago');
    expect(timeAgo(NOW - DAY, undefined, NOW)).toBe('Yesterday');
    expect(timeAgo(NOW - 4 * DAY, undefined, NOW)).toBe('4d ago');
  });

  it('delegates to the translator with the bucket key and its value', () => {
    const t = vi.fn(() => 'translated');

    expect(timeAgo(NOW - 5 * MIN, t, NOW)).toBe('translated');
    expect(t).toHaveBeenCalledWith(RELATIVE_TIME_KEYS.minutes, { value: 5 });

    timeAgo(NOW - DAY, t, NOW);
    // Valueless buckets pass no params rather than an empty object.
    expect(t).toHaveBeenLastCalledWith(RELATIVE_TIME_KEYS.yesterday);
  });
});
