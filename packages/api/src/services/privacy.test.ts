import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { recordPlayEvents, playEventCount, type PlayEventInput } from './play-history.js';
import {
  HISTORY_SETTING_KEY,
  deleteUserHistory,
  exportUserData,
  getInstanceHistoryEnabled,
  getRetentionDays,
  historyCollectionState,
  maybeRunDailyHistoryRetention,
  isHistoryEnabledForUser,
  pruneExpiredHistory,
  resolveHistoryCollection,
  setInstanceHistoryEnabled,
  setRetentionDays,
  setUserHistoryEnabled,
} from './privacy.js';

let db: Database;
const NOW = Date.UTC(2026, 7, 10, 12, 0, 0);
const DAY = 24 * 3_600_000;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  db.run(`INSERT INTO users (id, username, password_hash, role) VALUES ('u1','ana','h','user')`);
  db.run(`INSERT INTO users (id, username, password_hash, role) VALUES ('u2','bo','h','user')`);
});

let seq = 0;
function event(over: Partial<PlayEventInput> = {}): PlayEventInput {
  seq += 1;
  return {
    clientEventId: `evt-${seq}`,
    songId: 's1',
    startedAt: NOW,
    msPlayed: 200_000,
    durationMs: 300_000,
    reason: 'ended',
    source: null,
    device: null,
    title: 'T',
    artist: 'A',
    album: 'Al',
    ...over,
  };
}

describe('resolveHistoryCollection — precedence', () => {
  it('env off is an absolute floor no setting can lift', () => {
    // Mirrors the acquisition kill-switch: an operator who disabled collection
    // must not be overridden by whoever holds an admin account.
    expect(resolveHistoryCollection(false, true, true)).toBe(false);
    expect(resolveHistoryCollection(false, null, null)).toBe(false);
  });

  it('the instance setting can turn it off for everyone', () => {
    expect(resolveHistoryCollection(true, false, true)).toBe(false);
  });

  it('a user can turn it off for themselves', () => {
    expect(resolveHistoryCollection(true, true, false)).toBe(false);
  });

  it('defaults to on when nothing is set (opt-out model)', () => {
    expect(resolveHistoryCollection(true, null, null)).toBe(true);
  });

  it('is on only when every level allows it', () => {
    expect(resolveHistoryCollection(true, true, true)).toBe(true);
  });
});

describe('consent storage', () => {
  it('a user defaults to enabled and round-trips a change', () => {
    expect(isHistoryEnabledForUser(db, 'u1')).toBe(true);
    setUserHistoryEnabled(db, 'u1', false);
    expect(isHistoryEnabledForUser(db, 'u1')).toBe(false);
    setUserHistoryEnabled(db, 'u1', true);
    expect(isHistoryEnabledForUser(db, 'u1')).toBe(true);
  });

  it('does not affect another user', () => {
    setUserHistoryEnabled(db, 'u1', false);
    expect(isHistoryEnabledForUser(db, 'u2')).toBe(true);
  });

  it('creates the settings row for a user who has none yet', () => {
    db.run(`DELETE FROM user_settings`);
    setUserHistoryEnabled(db, 'u1', false);
    expect(isHistoryEnabledForUser(db, 'u1')).toBe(false);
  });

  it('the instance setting defaults to unset and round-trips', () => {
    expect(getInstanceHistoryEnabled(db)).toBeNull();
    setInstanceHistoryEnabled(db, false);
    expect(getInstanceHistoryEnabled(db)).toBe(false);
    expect(
      db
        .query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?')
        .get(HISTORY_SETTING_KEY)?.value,
    ).toBe('false');
  });
});

describe('historyCollectionState', () => {
  it('reports enabled with no reason when everything allows it', () => {
    expect(historyCollectionState(db, 'u1', true)).toEqual({ enabled: true, blockedBy: null });
  });

  it('names the env as the blocker, since that is the one an admin cannot fix', () => {
    expect(historyCollectionState(db, 'u1', false)).toEqual({ enabled: false, blockedBy: 'env' });
  });

  it('names the instance setting', () => {
    setInstanceHistoryEnabled(db, false);
    expect(historyCollectionState(db, 'u1', true)).toEqual({
      enabled: false,
      blockedBy: 'instance',
    });
  });

  it('names the user’s own choice', () => {
    setUserHistoryEnabled(db, 'u1', false);
    expect(historyCollectionState(db, 'u1', true)).toEqual({ enabled: false, blockedBy: 'user' });
  });

  it('reports the env floor even when the user also opted out', () => {
    // The most restrictive, least-fixable level wins the explanation.
    setUserHistoryEnabled(db, 'u1', false);
    expect(historyCollectionState(db, 'u1', false).blockedBy).toBe('env');
  });
});

describe('deleteUserHistory', () => {
  it('removes only the caller’s events', () => {
    recordPlayEvents(db, 'u1', [event(), event()]);
    recordPlayEvents(db, 'u2', [event()]);

    expect(deleteUserHistory(db, 'u1')).toBe(2);
    expect(playEventCount(db)).toBe(1);
  });

  it('is a no-op for a user with no history', () => {
    expect(deleteUserHistory(db, 'u1')).toBe(0);
  });

  it('leaves the consent setting alone — deleting is not opting out', () => {
    recordPlayEvents(db, 'u1', [event()]);
    deleteUserHistory(db, 'u1');
    expect(isHistoryEnabledForUser(db, 'u1')).toBe(true);
  });
});

describe('retention', () => {
  it('defaults to 0 — keep forever, the pre-#454 policy', () => {
    expect(getRetentionDays(db)).toBe(0);
  });

  it('round-trips and clamps a hostile value', () => {
    setRetentionDays(db, 90);
    expect(getRetentionDays(db)).toBe(90);
    setRetentionDays(db, -5);
    expect(getRetentionDays(db)).toBe(0);
  });

  it('prunes nothing when retention is off, however old the events', () => {
    recordPlayEvents(db, 'u1', [event({ startedAt: NOW - 3650 * DAY })]);
    expect(pruneExpiredHistory(db, NOW)).toBe(0);
    expect(playEventCount(db)).toBe(1);
  });

  it('drops events older than the cap and keeps the rest', () => {
    setRetentionDays(db, 30);
    recordPlayEvents(db, 'u1', [
      event({ startedAt: NOW - 40 * DAY }),
      event({ startedAt: NOW - 10 * DAY }),
    ]);
    expect(pruneExpiredHistory(db, NOW)).toBe(1);
    expect(playEventCount(db)).toBe(1);
  });

  it('keeps an event exactly at the boundary', () => {
    setRetentionDays(db, 30);
    recordPlayEvents(db, 'u1', [event({ startedAt: NOW - 30 * DAY })]);
    expect(pruneExpiredHistory(db, NOW)).toBe(0);
  });

  it('prunes across all users, not just one', () => {
    setRetentionDays(db, 30);
    recordPlayEvents(db, 'u1', [event({ startedAt: NOW - 40 * DAY })]);
    recordPlayEvents(db, 'u2', [event({ startedAt: NOW - 40 * DAY })]);
    expect(pruneExpiredHistory(db, NOW)).toBe(2);
  });
});

describe('exportUserData', () => {
  it('includes the account, settings and listening history', () => {
    recordPlayEvents(db, 'u1', [event({ songId: 'mine' })]);
    setUserHistoryEnabled(db, 'u1', true); // a fresh user has no settings row until they set one
    const bundle = exportUserData(db, 'u1');

    expect(bundle.user).toMatchObject({ id: 'u1', username: 'ana' });
    expect(bundle.tables['play_events']).toHaveLength(1);
    expect(bundle.tables['user_settings']).toHaveLength(1);
  });

  it('exports a user who has never set a preference, with empty tables not errors', () => {
    const bundle = exportUserData(db, 'u1');
    expect(bundle.user.username).toBe('ana');
    expect(bundle.tables['user_settings']).toEqual([]);
  });

  it('never exports the password hash', () => {
    const bundle = exportUserData(db, 'u1');
    expect(JSON.stringify(bundle)).not.toContain('password_hash');
    expect(bundle.user).not.toHaveProperty('passwordHash');
  });

  it('never exports another user’s rows', () => {
    recordPlayEvents(db, 'u1', [event({ songId: 'mine' })]);
    recordPlayEvents(db, 'u2', [event({ songId: 'theirs' })]);

    const json = JSON.stringify(exportUserData(db, 'u1'));
    expect(json).toContain('mine');
    expect(json).not.toContain('theirs');
  });

  it('redacts agent-token hashes while still reporting the tokens exist', () => {
    db.run(
      `INSERT INTO agent_tokens (id, user_id, name, token_hash, scope, created_at)
       VALUES ('t1','u1','mine','SECRETHASH','refiner:curate',1)`,
    );
    const bundle = exportUserData(db, 'u1');
    const json = JSON.stringify(bundle);
    expect(json).not.toContain('SECRETHASH');
    expect(bundle.tables['agent_tokens']).toHaveLength(1);
  });

  it('reports which tables it covered, so a gap is visible rather than silent', () => {
    expect(bundleTables(exportUserData(db, 'u1'))).toContain('play_events');
    expect(bundleTables(exportUserData(db, 'u1'))).toContain('playlists');
  });

  it('throws for an unknown user rather than returning an empty bundle', () => {
    // An empty bundle would read as "we hold nothing about you", which is a
    // very different claim from "no such user".
    expect(() => exportUserData(db, 'nobody')).toThrow(/not found/i);
  });
});

function bundleTables(b: ReturnType<typeof exportUserData>): string[] {
  return Object.keys(b.tables);
}

describe('maybeRunDailyHistoryRetention', () => {
  it('does nothing when no cap is set', () => {
    recordPlayEvents(db, 'u1', [event({ startedAt: NOW - 3650 * DAY })]);
    expect(maybeRunDailyHistoryRetention(db, { now: NOW })).toBe(0);
    expect(playEventCount(db)).toBe(1);
  });

  it('prunes once per day, then no-ops until the next', () => {
    setRetentionDays(db, 30);
    recordPlayEvents(db, 'u1', [event({ startedAt: NOW - 40 * DAY })]);
    expect(maybeRunDailyHistoryRetention(db, { now: NOW })).toBe(1);

    recordPlayEvents(db, 'u1', [event({ startedAt: NOW - 41 * DAY })]);
    expect(maybeRunDailyHistoryRetention(db, { now: NOW })).toBe(0); // marker holds
    expect(maybeRunDailyHistoryRetention(db, { now: NOW + DAY })).toBe(1); // next day
  });

  it('never throws — a retention failure must not break the processing tick', () => {
    setRetentionDays(db, 30);
    db.run('DROP TABLE play_events');
    expect(() => maybeRunDailyHistoryRetention(db, { now: NOW })).not.toThrow();
  });
});
