/**
 * Event-loop responsiveness during a backup (#1313): builds a throwaway WAL
 * database of roughly `--mb` megabytes, then runs the daily backup's snapshot
 * twice — in place on the caller's connection (the pre-#1313 path) and through
 * `snapshotDatabase`'s worker — while a 10 ms timer records how late each tick
 * fires. Reports max / p99 lateness and the snapshot duration for both.
 *
 *   bun run packages/api/src/scripts/measure-backup-loop.ts [--mb 80]
 *
 * Numbers and interpretation: docs/backup-restore.md "Off the event loop".
 */
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotDatabase } from '../services/backup.js';

export interface LoopSample {
  durationMs: number;
  ticks: number;
  maxLateMs: number;
  p99LateMs: number;
}

/** A WAL database of ~`mb` MB: one table of 1 KiB random-ish blobs. */
export function buildDatabase(path: string, mb: number): Database {
  const db = new Database(path, { create: true });
  db.run('PRAGMA journal_mode=WAL');
  db.run('CREATE TABLE filler (id INTEGER PRIMARY KEY, body BLOB NOT NULL, tag TEXT)');
  db.run('CREATE INDEX idx_filler_tag ON filler(tag)');
  db.run(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO filler (body, tag) SELECT randomblob(1024), 'tag-' || (i % 5000) FROM n`,
    [mb * 900],
  );
  return db;
}

/** Run `work` while a `periodMs` timer measures its own lateness. */
export async function measureLoop(work: () => Promise<void>, periodMs = 10): Promise<LoopSample> {
  const late: number[] = [];
  let expected = performance.now() + periodMs;
  const timer = setInterval(() => {
    const now = performance.now();
    late.push(Math.max(0, now - expected));
    expected = now + periodMs;
  }, periodMs);
  // Let the timer arm before the work starts, or a synchronous block is missed.
  await Bun.sleep(periodMs * 3);
  const started = performance.now();
  await work();
  const durationMs = performance.now() - started;
  await Bun.sleep(periodMs * 3);
  clearInterval(timer);
  // A tick that never came while the loop was blocked is recorded on the next.
  const sorted = [...late].sort((a, b) => a - b);
  return {
    durationMs: Math.round(durationMs),
    ticks: late.length,
    maxLateMs: Math.round(sorted.at(-1) ?? 0),
    p99LateMs: Math.round(sorted[Math.floor(sorted.length * 0.99)] ?? 0),
  };
}

if (import.meta.main) {
  const i = process.argv.indexOf('--mb');
  const mb = i > 0 ? Number(process.argv[i + 1]) : 80;
  const dir = mkdtempSync(join(tmpdir(), 'nicotind-backup-loop-'));
  try {
    const db = buildDatabase(join(dir, 'nicotind.db'), mb);
    const size = statSync(join(dir, 'nicotind.db')).size;
    console.log(`database: ${(size / 1e6).toFixed(1)} MB`);
    const inPlace = await measureLoop(async () => {
      db.run('VACUUM INTO ?', [join(dir, 'in-place.db')]);
    });
    const worker = await measureLoop(() => snapshotDatabase(db, join(dir, 'worker.db')));
    console.log('in place (main connection):', inPlace);
    console.log('worker (own connection):  ', worker);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
