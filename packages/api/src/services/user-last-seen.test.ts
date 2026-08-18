import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { LAST_SEEN_THROTTLE_MS, touchLastSeen, resetLastSeenThrottle } from './user-last-seen.js';

function makeDb(): Database {
  const db = new Database(':memory:');
  applySchema(db);
  db.run("INSERT INTO users (id, username, password_hash) VALUES ('u1', 'alice', 'x')");
  db.run("INSERT INTO users (id, username, password_hash) VALUES ('u2', 'bob', 'x')");
  return db;
}

function lastSeen(db: Database, id: string): number | null {
  return (
    db
      .query<{ last_seen_at: number | null }, [string]>(
        'SELECT last_seen_at FROM users WHERE id = ?',
      )
      .get(id)?.last_seen_at ?? null
  );
}

describe('touchLastSeen', () => {
  beforeEach(() => resetLastSeenThrottle());

  it('stamps last_seen_at on the first call', () => {
    const db = makeDb();
    expect(lastSeen(db, 'u1')).toBeNull();

    expect(touchLastSeen(db, 'u1', 1_000)).toBe(true);
    expect(lastSeen(db, 'u1')).toBe(1_000);
  });

  it('throttles a second call inside the window', () => {
    const db = makeDb();
    touchLastSeen(db, 'u1', 1_000);

    expect(touchLastSeen(db, 'u1', 1_000 + LAST_SEEN_THROTTLE_MS - 1)).toBe(false);
    // The stored value is the first write, not the throttled one.
    expect(lastSeen(db, 'u1')).toBe(1_000);
  });

  it('writes again once the window has passed', () => {
    const db = makeDb();
    touchLastSeen(db, 'u1', 1_000);

    const later = 1_000 + LAST_SEEN_THROTTLE_MS;
    expect(touchLastSeen(db, 'u1', later)).toBe(true);
    expect(lastSeen(db, 'u1')).toBe(later);
  });

  it('throttles per user, not globally', () => {
    const db = makeDb();
    touchLastSeen(db, 'u1', 1_000);

    // u2 has never been stamped, so u1's recent write must not suppress it.
    expect(touchLastSeen(db, 'u2', 1_000)).toBe(true);
    expect(lastSeen(db, 'u2')).toBe(1_000);
  });

  it('bypasses the throttle when forced (a login is a discrete event)', () => {
    const db = makeDb();
    touchLastSeen(db, 'u1', 1_000);

    expect(touchLastSeen(db, 'u1', 2_000, { force: true })).toBe(true);
    expect(lastSeen(db, 'u1')).toBe(2_000);
  });

  it('accepts a thunk and swallows a connection that cannot even be resolved', () => {
    // The presence route passes `getDatabase` unresolved: calling it before
    // touchLastSeen would throw *outside* this function's catch and 500 a
    // heartbeat, which is exactly what "best-effort telemetry" must not do.
    const boom = () => {
      throw new Error('Database not initialized');
    };
    expect(() => touchLastSeen(boom, 'u1', 1_000)).not.toThrow();
    expect(touchLastSeen(boom, 'u1', 1_000)).toBe(false);
  });

  it('resolves a thunk and writes through it', () => {
    const db = makeDb();
    expect(touchLastSeen(() => db, 'u1', 1_000)).toBe(true);
    expect(lastSeen(db, 'u1')).toBe(1_000);
  });

  it('swallows a write failure and lets the next call retry', () => {
    const db = makeDb();
    db.run('DROP TABLE users');

    // Best-effort telemetry: never throws, so a heartbeat or login can't 500 on it.
    expect(() => touchLastSeen(db, 'u1', 1_000)).not.toThrow();
    expect(touchLastSeen(db, 'u1', 1_000)).toBe(false);

    // The failed write must not have entered the throttle map — otherwise a
    // transient error would suppress writes for the whole window.
    applySchema(db);
    db.run("INSERT INTO users (id, username, password_hash) VALUES ('u1', 'alice', 'x')");
    expect(touchLastSeen(db, 'u1', 1_001)).toBe(true);
    expect(lastSeen(db, 'u1')).toBe(1_001);
  });
});
