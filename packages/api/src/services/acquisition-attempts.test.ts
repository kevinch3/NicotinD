import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  ATTEMPT_RETENTION_MS,
  pruneAttempts,
  recordAttempt,
  reportAttempt,
  setAttemptRecorder,
  type AttemptRecord,
} from './acquisition-attempts.js';
import { AddonClient } from './addons/client.js';
import { reconcileOnBoot } from './acquisition-job-store.js';

function freshDb(): Database {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

const rows = (db: Database) =>
  db.query('SELECT * FROM acquisition_attempts ORDER BY id').all() as Record<string, unknown>[];

const quiet = { info: () => {}, warn: () => {} };

function client(respond: () => Response) {
  const fetchFn = (async () => respond()) as unknown as typeof fetch;
  return new AddonClient({ baseUrl: 'http://addon', token: 't', fetchFn, log: quiet });
}

const searchAnswer = (over: Record<string, unknown> = {}) =>
  Response.json({
    candidates: [],
    queries: [],
    skewNeeded: false,
    searchesFired: 3,
    searchesAnswered: 1,
    ...over,
  });

afterEach(() => setAttemptRecorder(null));

describe('acquisition attempt ledger (#1626)', () => {
  it('records nothing until boot wires a recorder', () => {
    expect(() => reportAttempt({ kind: 'hunt', outcome: 'error' })).not.toThrow();
  });

  it('a ledger write that throws never fails the acquisition', () => {
    setAttemptRecorder(() => {
      throw new Error('disk full');
    });
    expect(() => reportAttempt({ kind: 'hunt', outcome: 'error' })).not.toThrow();
  });

  it('writes one hunt row with its lane, album and outcome', async () => {
    const db = freshDb();
    setAttemptRecorder((r) => recordAttempt(db, r));
    await client(() => searchAnswer({ sourceOffline: true })).albumsSearch(
      { artist: 'A', album: 'B', canonicalTracks: [{ title: 'One' }] },
      { lane: 'hunt-queue', albumId: 42, queuedMs: 900, attemptId: 'h1' },
    );
    expect(rows(db)).toEqual([
      expect.objectContaining({
        kind: 'hunt',
        lane: 'hunt-queue',
        attempt_id: 'h1',
        lidarr_album_id: 42,
        artist: 'A',
        album: 'B',
        outcome: 'source-offline',
        queued_ms: 900,
        candidates: 0,
        searches_fired: 3,
        searches_answered: 1,
      }),
    ]);
  });

  it('writes a failed hunt as an error row with its reason', async () => {
    const db = freshDb();
    setAttemptRecorder((r) => recordAttempt(db, r));
    await expect(
      client(() => new Response('boom', { status: 500 })).albumsSearch(
        { artist: 'A', album: 'B', canonicalTracks: [] },
        { lane: 'watchlist', albumId: 7 },
      ),
    ).rejects.toThrow();
    const [row] = rows(db);
    expect(row).toMatchObject({ kind: 'hunt', lane: 'watchlist', outcome: 'error' });
    expect(String(row!.detail)).toContain('500');
  });

  it('writes an enqueue row: created, or conflict on the per-album 409', async () => {
    const db = freshDb();
    setAttemptRecorder((r) => recordAttempt(db, r));
    const job = { id: 'j1', intent: 'album', state: 'active', items: [] };
    await client(() => Response.json({ job })).createJob(
      { intent: 'album', artist: 'A', album: 'B' },
      'acquire:99',
    );
    await expect(
      client(() => Response.json({ error: 'busy' }, { status: 409 })).createJob(
        { intent: 'album', artist: 'A', album: 'B' },
        undefined,
        { lane: 'hunt-download', albumId: 5 },
      ),
    ).rejects.toThrow();
    expect(rows(db).map((r) => [r.kind, r.lane, r.lidarr_album_id, r.outcome])).toEqual([
      ['enqueue', 'intent:album', 99, 'created'],
      ['enqueue', 'hunt-download', 5, 'conflict'],
    ]);
  });

  it('job hygiene prunes rows past the 90-day retention, and keeps the rest', () => {
    const db = freshDb();
    const now = Date.now();
    const r: AttemptRecord = { kind: 'hunt', outcome: 'no-candidates' };
    recordAttempt(db, r, now - ATTEMPT_RETENTION_MS - 1);
    recordAttempt(db, r, now - ATTEMPT_RETENTION_MS + 60_000);
    reconcileOnBoot(db, now);
    expect(rows(db)).toHaveLength(1);
    expect(pruneAttempts(db, now)).toBe(0);
  });
});
