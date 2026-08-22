import { describe, expect, it, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { listBackups, runBackup } from './backup.js';
import {
  hasSomethingToLose,
  migrationBackupEnabled,
  migrationBackupsRoot,
  pruneMigrationBackups,
  runMigrationBackup,
} from './migration-backup.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'nicotind-migbak-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A real on-disk WAL database, since VACUUM INTO is the whole mechanism. */
function realDb(dataDir: string): Database {
  const db = new Database(join(dataDir, 'nicotind.db'), { create: true });
  db.run('PRAGMA journal_mode=WAL');
  db.run('CREATE TABLE t (x INTEGER)');
  db.run('INSERT INTO t VALUES (1)');
  return db;
}

const plentyOfSpace = () => ({ bsize: 4096, blocks: 1e9, bavail: 1e9 });

describe('runMigrationBackup', () => {
  it('writes a usable snapshot into its own subdirectory', () => {
    const dataDir = tmp();
    const db = realDb(dataDir);

    const res = runMigrationBackup(db, {
      dataDir,
      fromVersion: 0,
      toVersion: 1,
      statfs: plentyOfSpace,
    });

    expect(res.name).toMatch(/^v0-to-v1-\d{8}-\d{6}$/);
    expect(existsSync(join(res.dir, 'nicotind.db'))).toBe(true);
    // The snapshot is a real database, not a truncated copy.
    const snap = new Database(join(res.dir, 'nicotind.db'), { readonly: true });
    expect(snap.query('SELECT x FROM t').get()).toEqual({ x: 1 });
  });

  it('copies secrets.json alongside the database when present', () => {
    const dataDir = tmp();
    const db = realDb(dataDir);
    writeFileSync(join(dataDir, 'secrets.json'), '{"jwt":"s"}');

    const res = runMigrationBackup(db, {
      dataDir,
      fromVersion: 0,
      toVersion: 1,
      statfs: plentyOfSpace,
    });

    expect(existsSync(join(res.dir, 'secrets.json'))).toBe(true);
  });

  it('stays out of the daily rotation entirely', () => {
    // A pre-migration snapshot must not evict a daily one, nor rotate out on
    // the 7-day clock: the upgrade it protects may not be noticed as bad for
    // weeks. It sits under backups/pre-migrate/, which listBackups' name
    // pattern cannot match, so pruneBackups can never reach it.
    const dataDir = tmp();
    const db = realDb(dataDir);

    runMigrationBackup(db, { dataDir, fromVersion: 0, toVersion: 1, statfs: plentyOfSpace });
    // Fill the daily rotation well past its keep count.
    for (let i = 0; i < 9; i++) {
      runBackup(db, { dataDir, keepCount: 2, now: Date.UTC(2026, 0, 1 + i, 12) });
    }

    expect(listBackups(dataDir).length).toBe(2);
    expect(readdirSync(migrationBackupsRoot(dataDir)).length).toBe(1);
  });

  it('suffixes rather than deleting when a name is taken', () => {
    // The daily backup rmSync's its target first, so two runs in the same
    // second silently delete one another. Deleting a backup to make room for a
    // backup is never right.
    const dataDir = tmp();
    const db = realDb(dataDir);
    const now = Date.UTC(2026, 5, 1, 10, 30, 15);

    const a = runMigrationBackup(db, {
      dataDir,
      fromVersion: 0,
      toVersion: 1,
      now,
      statfs: plentyOfSpace,
    });
    const b = runMigrationBackup(db, {
      dataDir,
      fromVersion: 0,
      toVersion: 1,
      now,
      statfs: plentyOfSpace,
    });

    expect(b.name).not.toBe(a.name);
    expect(existsSync(join(a.dir, 'nicotind.db'))).toBe(true);
    expect(existsSync(join(b.dir, 'nicotind.db'))).toBe(true);
  });

  it('refuses with an actionable message when the disk is too full', () => {
    const dataDir = tmp();
    const db = realDb(dataDir);

    expect(() =>
      runMigrationBackup(db, {
        dataDir,
        fromVersion: 0,
        toVersion: 1,
        statfs: () => ({ bsize: 1, blocks: 1, bavail: 1 }),
      }),
    ).toThrow(/need ~\d+ MB free/);
  });

  it('names the opt-out in that message, so the operator can choose', () => {
    const dataDir = tmp();
    const db = realDb(dataDir);
    expect(() =>
      runMigrationBackup(db, {
        dataDir,
        fromVersion: 0,
        toVersion: 1,
        statfs: () => ({ bsize: 1, blocks: 1, bavail: 1 }),
      }),
    ).toThrow(/NICOTIND_MIGRATION_BACKUP=off/);
  });

  it('proceeds when free space cannot be determined', () => {
    // An unreadable statfs must not block an upgrade — unknown is not "full".
    const dataDir = tmp();
    const db = realDb(dataDir);
    expect(() =>
      runMigrationBackup(db, {
        dataDir,
        fromVersion: 0,
        toVersion: 1,
        statfs: () => {
          throw new Error('nope');
        },
      }),
    ).not.toThrow();
  });
});

describe('pruneMigrationBackups', () => {
  it('keeps the newest N and only touches its own names', () => {
    const dataDir = tmp();
    const root = migrationBackupsRoot(dataDir);
    mkdirSync(root, { recursive: true });
    for (const n of [
      'v0-to-v1-20260101-000000',
      'v1-to-v2-20260201-000000',
      'v2-to-v3-20260301-000000',
    ])
      mkdirSync(join(root, n));
    mkdirSync(join(root, 'not-ours'));

    pruneMigrationBackups(dataDir, 2);

    const left = readdirSync(root).sort();
    expect(left).toEqual(['not-ours', 'v1-to-v2-20260201-000000', 'v2-to-v3-20260301-000000']);
  });
});

describe('migrationBackupEnabled', () => {
  it('is on by default', () => {
    expect(migrationBackupEnabled({} as NodeJS.ProcessEnv)).toBe(true);
  });

  it('is turned off only by its own switch', () => {
    expect(migrationBackupEnabled({ NICOTIND_MIGRATION_BACKUP: 'off' } as NodeJS.ProcessEnv)).toBe(
      false,
    );
    expect(migrationBackupEnabled({ NICOTIND_MIGRATION_BACKUP: 'OFF' } as NodeJS.ProcessEnv)).toBe(
      false,
    );
  });

  it('is NOT suppressed by NICOTIND_BACKUP=off', () => {
    // That flag means "stop filling my disk with daily snapshots". This is a
    // safety net for an irreversible operation that runs at most once per
    // version bump, so it gets its own switch rather than inheriting one whose
    // meaning does not fit.
    expect(migrationBackupEnabled({ NICOTIND_BACKUP: 'off' } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe('every migration path is hooked', () => {
  it('passes onBeforeMigrate at every non-test applySchema call site', () => {
    // Hooking only initDatabase would reproduce the #457/#606 shape: a narrow
    // entry point that silently misses the others. Two maintenance scripts
    // already migrate a real on-disk database without going through it, and a
    // third would be just as invisible — so the invariant is enforced here
    // rather than remembered.
    const root = resolve(import.meta.dir, '../../../..');
    const out = execFileSync(
      'git',
      ['grep', '-n', '-w', 'applySchema', '--', 'packages/api/src', ':!*.test.ts'],
      { cwd: root, encoding: 'utf8' },
    );
    const calls = out
      .split('\n')
      .filter((l) => /applySchema\(/.test(l))
      // The declaration itself, and the doc comment above it.
      .filter((l) => !/export function applySchema\(/.test(l));

    expect(calls.length).toBeGreaterThan(0);
    for (const line of calls) {
      expect(line).toContain('onBeforeMigrate');
    }
  });
});

describe('hasSomethingToLose', () => {
  it('is false for a brand-new empty database', () => {
    // A fresh install is at version 0 exactly like a legacy one, so without
    // this every new deployment (and every e2e run, and every throwaway
    // container) would snapshot an empty file on its first boot.
    expect(hasSomethingToLose(new Database(':memory:'))).toBe(false);
  });

  it('is true once the database holds any table', () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE users (id TEXT PRIMARY KEY)');
    expect(hasSomethingToLose(db)).toBe(true);
  });
});
