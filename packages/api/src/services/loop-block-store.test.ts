import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { applySchema } from '../db.js';
import { resetInFlight, trackInFlight } from '../middleware/in-flight.js';
import {
  LOOP_BLOCK_MAX_ROWS,
  LOOP_BLOCK_RETENTION_MS,
  recordLoopBlock,
  startLoopBlockRecorder,
} from './loop-block-store.js';

const DAY = 24 * 60 * 60 * 1000;

function freshDb(): Database {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

function rows(db: Database) {
  return db
    .query<{ at: number; blocked_ms: number; in_flight: string }, []>(
      'SELECT at, blocked_ms, in_flight FROM loop_blocks ORDER BY id',
    )
    .all();
}

afterEach(() => resetInFlight());

describe('recordLoopBlock', () => {
  it('persists the timestamp, duration and in-flight requests', () => {
    const db = freshDb();
    recordLoopBlock(
      db,
      { blockedMs: 1304, inFlight: ['GET /api/library/artists (1300ms)'] },
      5_000,
    );
    expect(rows(db)).toEqual([
      { at: 5_000, blocked_ms: 1304, in_flight: '["GET /api/library/artists (1300ms)"]' },
    ]);
  });

  it('prunes rows older than the retention window on write', () => {
    const db = freshDb();
    const now = 400 * DAY;
    recordLoopBlock(db, { blockedMs: 1000, inFlight: [] }, now - LOOP_BLOCK_RETENTION_MS - 1);
    recordLoopBlock(db, { blockedMs: 2000, inFlight: [] }, now - LOOP_BLOCK_RETENTION_MS + 1);
    recordLoopBlock(db, { blockedMs: 3000, inFlight: [] }, now);
    expect(rows(db).map((r) => r.blocked_ms)).toEqual([2000, 3000]);
  });

  it('caps the table at LOOP_BLOCK_MAX_ROWS, dropping the oldest', () => {
    const db = freshDb();
    const insert = db.prepare(
      'INSERT INTO loop_blocks (at, blocked_ms, in_flight) VALUES (?, ?, ?)',
    );
    db.transaction(() => {
      for (let i = 0; i < LOOP_BLOCK_MAX_ROWS; i++) insert.run(DAY + i, 1000, '[]');
    })();
    recordLoopBlock(db, { blockedMs: 9999, inFlight: [] }, 2 * DAY);
    const count = db.query<{ c: number }, []>('SELECT COUNT(*) c FROM loop_blocks').get()!.c;
    expect(count).toBe(LOOP_BLOCK_MAX_ROWS);
    const oldest = db.query<{ at: number }, []>('SELECT MIN(at) at FROM loop_blocks').get()!.at;
    expect(oldest).toBe(DAY + 1);
  });

  it('never throws — a diagnostic write must not take down the process', () => {
    const db = freshDb();
    db.close();
    expect(() => recordLoopBlock(db, { blockedMs: 1000, inFlight: [] })).not.toThrow();
  });
});

describe('startLoopBlockRecorder — the wiring createApp uses', () => {
  it('stamps when recording began, once', () => {
    const db = freshDb();
    startLoopBlockRecorder(db)();
    const first = db
      .query<{ value: string }, []>(
        "SELECT value FROM library_sync_state WHERE key = 'loop_blocks_recording_since'",
      )
      .get()!.value;
    startLoopBlockRecorder(db)();
    const second = db
      .query<{ value: string }, []>(
        "SELECT value FROM library_sync_state WHERE key = 'loop_blocks_recording_since'",
      )
      .get()!.value;
    expect(Number(first)).toBeGreaterThan(0);
    expect(second).toBe(first);
  });

  it('a real synchronous request block lands as a row naming that request', async () => {
    const db = freshDb();
    const app = new Hono();
    app.use('/api/*', trackInFlight());
    app.get('/api/library/artists', (c) => {
      const until = performance.now() + 300;
      while (performance.now() < until) {
        /* spin, like a synchronous bun:sqlite .all() */
      }
      return c.json([]);
    });
    const stop = startLoopBlockRecorder(db, { intervalMs: 20, budgetMs: 100 });
    try {
      await new Promise((r) => setTimeout(r, 30));
      await app.request('/api/library/artists?country=CL,unknown');
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      stop();
    }
    const persisted = rows(db);
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted[0]!.blocked_ms).toBeGreaterThan(100);
    const inFlight = JSON.parse(persisted[0]!.in_flight) as string[];
    expect(inFlight.some((l) => l.startsWith('GET /api/library/artists?country ('))).toBe(true);
  });
});

describe('createApp wiring', () => {
  it('starts the persisting recorder, not the log-only monitor (#1058)', async () => {
    const src = await Bun.file(new URL('../index.ts', import.meta.url)).text();
    expect(src).toMatch(/startLoopBlockRecorder\(db\)/);
    expect(src).not.toMatch(/startLoopBlockMonitor\(/);
  });
});
