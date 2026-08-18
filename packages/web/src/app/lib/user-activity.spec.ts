import { describe, it, expect } from 'vitest';
import { userActivityLabel, userActivityDetail, type UserActivity } from './user-activity';

const NOW = 1_700_000_000_000;

/** Echoes the key so a spec asserts which string was asked for, not its English. */
const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}:${JSON.stringify(params)}` : key;

const user = (over: Partial<UserActivity> = {}): UserActivity => ({
  isConnected: false,
  last_seen_at: null,
  amountOfDevices: 0,
  amountOfSessions: 0,
  ...over,
});

describe('userActivityLabel', () => {
  it('reads Online while connected, even with a stale stamp', () => {
    // last_seen_at is throttled to one write per 5 min, so a user who is online
    // right now routinely carries a timestamp minutes old. Presence must win.
    expect(
      userActivityLabel(user({ isConnected: true, last_seen_at: NOW - 240_000 }), t, NOW),
    ).toBe('admin.online');
  });

  it('reads Never for an account that has never connected', () => {
    expect(userActivityLabel(user(), t, NOW)).toBe('admin.neverConnected');
  });

  it('falls back to a relative stamp when offline', () => {
    expect(userActivityLabel(user({ last_seen_at: NOW - 3 * 86_400_000 }), t, NOW)).toBe(
      'time.daysAgo:{"value":3}',
    );
  });
});

describe('userActivityDetail', () => {
  it('carries the old Devices/Sessions columns while connected', () => {
    expect(
      userActivityDetail(user({ isConnected: true, amountOfDevices: 2, amountOfSessions: 3 }), t),
    ).toBe('admin.activityDetail:{"devices":2,"sessions":3}');
  });

  it('is empty when offline, so the row does not render "0 devices · 0 sessions"', () => {
    expect(userActivityDetail(user({ last_seen_at: NOW }), t)).toBe('');
  });
});
