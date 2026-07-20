import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  checkForUpdateNow,
  compareVersions,
  getStoredUpdateCheck,
  listVersionHistory,
  maybeCheckForUpdate,
  recordBootVersion,
  type FetchLike,
} from './update-check.js';

const db = new Database(':memory:');
applySchema(db);

beforeEach(() => {
  db.run('DELETE FROM library_sync_state');
  db.run('DELETE FROM version_history');
});

function fakeRelease(tag: string): FetchLike {
  return async () =>
    new Response(
      JSON.stringify({ tag_name: tag, html_url: `https://github.com/x/releases/${tag}` }),
      { status: 200 },
    );
}

const failing: FetchLike = async () => new Response('rate limited', { status: 403 });

describe('compareVersions', () => {
  it('orders numeric dot versions', () => {
    expect(compareVersions('0.1.231', '0.1.230')).toBeGreaterThan(0);
    expect(compareVersions('0.1.230', '0.1.230')).toBe(0);
    expect(compareVersions('0.2.0', '0.1.999')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('v0.1.231', '0.1.230')).toBeGreaterThan(0);
    expect(compareVersions('0.1', '0.1.0')).toBe(0);
  });
});

describe('checkForUpdateNow', () => {
  it('stores the latest release (v-prefix stripped)', async () => {
    const r = await checkForUpdateNow(db, { now: 1000, fetchImpl: fakeRelease('v0.1.231') });
    expect(r?.latestVersion).toBe('0.1.231');
    expect(getStoredUpdateCheck(db)?.latestVersion).toBe('0.1.231');
  });

  it('returns null and keeps the previous result on failure', async () => {
    await checkForUpdateNow(db, { now: 1000, fetchImpl: fakeRelease('v0.1.231') });
    const r = await checkForUpdateNow(db, { now: 2000, fetchImpl: failing });
    expect(r).toBeNull();
    expect(getStoredUpdateCheck(db)?.latestVersion).toBe('0.1.231');
  });
});

describe('maybeCheckForUpdate', () => {
  const day = 24 * 3_600_000;

  it('polls once per 24h', async () => {
    const t0 = day; // far enough from 0 that backoff math has room
    expect(await maybeCheckForUpdate(db, { now: t0, fetchImpl: fakeRelease('v1.0.0') })).toBe(true);
    expect(await maybeCheckForUpdate(db, { now: t0 + 3_600_000, fetchImpl: fakeRelease('v2.0.0') })).toBe(false);
    expect(await maybeCheckForUpdate(db, { now: t0 + day, fetchImpl: fakeRelease('v2.0.0') })).toBe(true);
    expect(getStoredUpdateCheck(db)?.latestVersion).toBe('2.0.0');
  });

  it('backs off 1h between failed attempts', async () => {
    const t0 = day;
    expect(await maybeCheckForUpdate(db, { now: t0, fetchImpl: failing })).toBe(true);
    expect(await maybeCheckForUpdate(db, { now: t0 + 60_000, fetchImpl: fakeRelease('v1.0.0') })).toBe(false);
    expect(await maybeCheckForUpdate(db, { now: t0 + 3_700_000, fetchImpl: fakeRelease('v1.0.0') })).toBe(true);
  });

  it('is a no-op when disabled', async () => {
    expect(await maybeCheckForUpdate(db, { now: day, fetchImpl: fakeRelease('v1.0.0'), enabled: false })).toBe(false);
  });
});

describe('version history', () => {
  it('records each version once, listed newest-first', () => {
    recordBootVersion(db, '0.1.229', 100);
    recordBootVersion(db, '0.1.229', 200); // rebooted same version — no dup
    recordBootVersion(db, '0.1.230', 300);
    const rows = listVersionHistory(db);
    expect(rows).toEqual([
      { version: '0.1.230', firstSeenAt: 300 },
      { version: '0.1.229', firstSeenAt: 100 },
    ]);
  });
});
