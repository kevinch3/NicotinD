import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySchema } from '../db.js';
import { measureLoop, buildDatabase } from '../scripts/measure-backup-loop.js';
import {
  listBackups,
  maybeRunDailyBackup,
  pruneBackups,
  runBackup,
  snapshotDatabase,
} from './backup.js';

const db = new Database(':memory:');
applySchema(db);
db.run(
  "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1', 'admin', 'x', 'admin', '2020-01-01')",
);

const dataDir = mkdtempSync(join(tmpdir(), 'nicotind-backup-'));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

// A fixed daytime clock (local 12:00) that satisfies the >= 04:00 gate.
const noon = new Date(2026, 6, 20, 12, 0, 0).getTime();

beforeEach(() => {
  db.run('DELETE FROM library_sync_state');
  rmSync(join(dataDir, 'backups'), { recursive: true, force: true });
});

describe('runBackup', () => {
  it('snapshots the DB (openable, data intact) and copies secrets.json', async () => {
    writeFileSync(join(dataDir, 'secrets.json'), '{"jwtSecret":"s"}');
    const info = await runBackup(db, { dataDir, now: noon });

    expect(info.files).toEqual(['nicotind.db', 'secrets.json']);
    expect(info.sizeBytes).toBeGreaterThan(0);

    const snap = new Database(join(dataDir, 'backups', info.name, 'nicotind.db'), {
      readonly: true,
    });
    const row = snap.query<{ username: string }, []>('SELECT username FROM users').get();
    expect(row?.username).toBe('admin');
    snap.close();
  });

  it('works without a secrets.json', async () => {
    rmSync(join(dataDir, 'secrets.json'), { force: true });
    const info = await runBackup(db, { dataDir, now: noon });
    expect(info.files).toEqual(['nicotind.db']);
  });
});

describe('pruneBackups / listBackups', () => {
  it('keeps only the newest N backups, newest first', async () => {
    for (let i = 0; i < 5; i++)
      await runBackup(db, { dataDir, now: noon + i * 1000, keepCount: 99 });
    expect(listBackups(dataDir)).toHaveLength(5);

    pruneBackups(dataDir, 3);
    const left = listBackups(dataDir);
    expect(left).toHaveLength(3);
    // Newest first, and the two oldest are the ones that went.
    expect(left[0]!.name > left[2]!.name).toBe(true);
  });

  it('ignores foreign directories in backups/', async () => {
    await runBackup(db, { dataDir, now: noon });
    const foreign = join(dataDir, 'backups', 'not-a-backup');
    writeFileSync(join(dataDir, 'backups', 'stray-file'), 'x');
    rmSync(foreign, { recursive: true, force: true });
    expect(listBackups(dataDir)).toHaveLength(1);
    pruneBackups(dataDir, 1);
    expect(existsSync(join(dataDir, 'backups', 'stray-file'))).toBe(true);
  });
});

describe('maybeRunDailyBackup', () => {
  it('runs once per calendar day', async () => {
    expect(await maybeRunDailyBackup(db, { dataDir, now: noon })).toBe(true);
    expect(await maybeRunDailyBackup(db, { dataDir, now: noon + 3_600_000 })).toBe(false);
    // Next day → runs again.
    expect(await maybeRunDailyBackup(db, { dataDir, now: noon + 24 * 3_600_000 })).toBe(true);
    expect(readdirSync(join(dataDir, 'backups'))).toHaveLength(2);
  });

  it('waits for 04:00 local', async () => {
    const twoAm = new Date(2026, 6, 20, 2, 0, 0).getTime();
    expect(await maybeRunDailyBackup(db, { dataDir, now: twoAm })).toBe(false);
  });

  it('is a no-op when disabled', async () => {
    expect(await maybeRunDailyBackup(db, { dataDir, now: noon, enabled: false })).toBe(false);
  });
});

describe('snapshot off the main thread (#1313)', () => {
  it('snapshots a file database in a worker, never on the caller connection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nicotind-backup-file-'));
    try {
      const fileDb = new Database(join(dir, 'nicotind.db'));
      fileDb.run('PRAGMA journal_mode=WAL');
      applySchema(fileDb);
      fileDb.run(
        "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u2', 'owner', 'x', 'admin', '2020-01-01')",
      );
      const calls: string[] = [];
      const realRun = fileDb.run.bind(fileDb);
      fileDb.run = ((sql: string, ...rest: unknown[]) => {
        calls.push(String(sql));
        return (realRun as (...a: unknown[]) => unknown)(sql, ...rest);
      }) as typeof fileDb.run;

      const info = await runBackup(fileDb, { dataDir: dir, now: noon });

      expect(calls.some((c) => c.includes('VACUUM'))).toBe(false);
      const snap = new Database(join(dir, 'backups', info.name, 'nicotind.db'), { readonly: true });
      expect(
        snap.query<{ username: string }, []>('SELECT username FROM users').get()?.username,
      ).toBe('owner');
      snap.close();
      fileDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('surfaces a worker failure as a rejected backup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nicotind-backup-fail-'));
    try {
      const fileDb = new Database(join(dir, 'nicotind.db'));
      applySchema(fileDb);
      // A target the worker cannot create: its directory does not exist.
      await expect(snapshotDatabase(fileDb, join(dir, 'missing', 'x.db'))).rejects.toThrow();
      fileDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts one daily backup at a time while a snapshot is in flight', async () => {
    const [a, b] = await Promise.all([
      maybeRunDailyBackup(db, { dataDir, now: noon }),
      maybeRunDailyBackup(db, { dataDir, now: noon }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});

/** A worker whose body is `code`, standing in for backup-worker.ts. */
function workerOf(code: string): string {
  return URL.createObjectURL(new Blob([code], { type: 'application/typescript' }));
}

function fileDatabase(): { dir: string; db: Database } {
  const dir = mkdtempSync(join(tmpdir(), 'nicotind-backup-worker-'));
  const fileDb = new Database(join(dir, 'nicotind.db'));
  fileDb.run('PRAGMA journal_mode=WAL');
  applySchema(fileDb);
  fileDb.run(
    "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u3', 'keeper', 'x', 'admin', '2020-01-01')",
  );
  return { dir, db: fileDb };
}

describe('snapshot worker failure handling (#1313)', () => {
  const crashes = workerOf("self.onmessage = () => { throw new Error('boom'); };");
  const exits = workerOf('self.onmessage = () => process.exit(3);');
  const hangs = workerOf('self.onmessage = () => {};');

  it('reports a crashing worker as a failed snapshot', async () => {
    const { dir, db: fileDb } = fileDatabase();
    try {
      await expect(
        snapshotDatabase(fileDb, join(dir, 'x.db'), { workerUrl: crashes }),
      ).rejects.toThrow(/crashed/);
    } finally {
      fileDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a worker that exits without answering as a failed snapshot', async () => {
    const { dir, db: fileDb } = fileDatabase();
    try {
      await expect(
        snapshotDatabase(fileDb, join(dir, 'x.db'), { workerUrl: exits }),
      ).rejects.toThrow(/exited without a result/);
    } finally {
      fileDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('times a hung worker out instead of waiting forever', async () => {
    const { dir, db: fileDb } = fileDatabase();
    try {
      const started = performance.now();
      await expect(
        snapshotDatabase(fileDb, join(dir, 'x.db'), { workerUrl: hangs, timeoutMs: 150 }),
      ).rejects.toThrow(/timed out/);
      expect(performance.now() - started).toBeLessThan(5_000);
    } finally {
      fileDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a failed backup leaves no backup behind and frees the daily guard', async () => {
    const { dir, db: fileDb } = fileDatabase();
    try {
      await expect(
        runBackup(fileDb, {
          dataDir: dir,
          now: noon,
          snapshot: { workerUrl: hangs, timeoutMs: 100 },
        }),
      ).rejects.toThrow(/timed out/);
      expect(listBackups(dir)).toHaveLength(0);

      const failed = await maybeRunDailyBackup(fileDb, {
        dataDir: dir,
        now: noon,
        snapshot: { workerUrl: crashes },
      });
      expect(failed).toBe(false);
      // Not marked done and not stuck in flight: the next tick backs up for real.
      expect(await maybeRunDailyBackup(fileDb, { dataDir: dir, now: noon })).toBe(true);
      expect(listBackups(dir)).toHaveLength(1);
    } finally {
      fileDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('produces a snapshot that passes integrity_check and opens as a live database', async () => {
    const { dir, db: fileDb } = fileDatabase();
    try {
      // Uncheckpointed WAL content must be in the copy: the worker's connection
      // reads the WAL, not just the main file.
      fileDb.run(
        "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u4', 'in-wal', 'x', 'user', '2020-01-01')",
      );
      const info = await runBackup(fileDb, { dataDir: dir, now: noon });
      const restored = new Database(join(dir, 'backups', info.name, 'nicotind.db'));
      expect(
        restored.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get(),
      ).toEqual({
        integrity_check: 'ok',
      });
      applySchema(restored);
      const names = restored
        .query<{ username: string }, []>('SELECT username FROM users ORDER BY username')
        .all()
        .map((r) => r.username);
      expect(names).toEqual(['in-wal', 'keeper']);
      restored.close();
    } finally {
      fileDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('event loop during a backup (#1313)', () => {
  it('keeps a 10 ms timer firing while a ~100 MB database is snapshotted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nicotind-backup-loop-'));
    try {
      const big = buildDatabase(join(dir, 'nicotind.db'), 100);
      const inPlace = await measureLoop(async () => {
        big.run('VACUUM INTO ?', [join(dir, 'in-place.db')]);
      });
      const offThread = await measureLoop(() => snapshotDatabase(big, join(dir, 'worker.db')));
      big.close();
      // The probe sees a block: in place, the one late tick is the whole copy.
      expect(inPlace.maxLateMs).toBeGreaterThanOrEqual(inPlace.durationMs * 0.8);
      // Off-thread, the loop keeps ticking through a copy of similar length.
      expect(offThread.maxLateMs).toBeLessThan(offThread.durationMs * 0.5);
      expect(offThread.ticks).toBeGreaterThan(inPlace.ticks);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
