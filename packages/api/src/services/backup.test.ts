import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySchema } from '../db.js';
import { listBackups, maybeRunDailyBackup, pruneBackups, runBackup } from './backup.js';

const db = new Database(':memory:');
applySchema(db);
db.run("INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1', 'admin', 'x', 'admin', '2020-01-01')");

const dataDir = mkdtempSync(join(tmpdir(), 'nicotind-backup-'));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

// A fixed daytime clock (local 12:00) that satisfies the >= 04:00 gate.
const noon = new Date(2026, 6, 20, 12, 0, 0).getTime();

beforeEach(() => {
  db.run('DELETE FROM library_sync_state');
  rmSync(join(dataDir, 'backups'), { recursive: true, force: true });
});

describe('runBackup', () => {
  it('snapshots the DB (openable, data intact) and copies secrets.json', () => {
    writeFileSync(join(dataDir, 'secrets.json'), '{"jwtSecret":"s"}');
    const info = runBackup(db, { dataDir, now: noon });

    expect(info.files).toEqual(['nicotind.db', 'secrets.json']);
    expect(info.sizeBytes).toBeGreaterThan(0);

    const snap = new Database(join(dataDir, 'backups', info.name, 'nicotind.db'), {
      readonly: true,
    });
    const row = snap.query<{ username: string }, []>('SELECT username FROM users').get();
    expect(row?.username).toBe('admin');
    snap.close();
  });

  it('works without a secrets.json', () => {
    rmSync(join(dataDir, 'secrets.json'), { force: true });
    const info = runBackup(db, { dataDir, now: noon });
    expect(info.files).toEqual(['nicotind.db']);
  });
});

describe('pruneBackups / listBackups', () => {
  it('keeps only the newest N backups, newest first', () => {
    for (let i = 0; i < 5; i++) runBackup(db, { dataDir, now: noon + i * 1000, keepCount: 99 });
    expect(listBackups(dataDir)).toHaveLength(5);

    pruneBackups(dataDir, 3);
    const left = listBackups(dataDir);
    expect(left).toHaveLength(3);
    // Newest first, and the two oldest are the ones that went.
    expect(left[0]!.name > left[2]!.name).toBe(true);
  });

  it('ignores foreign directories in backups/', () => {
    runBackup(db, { dataDir, now: noon });
    const foreign = join(dataDir, 'backups', 'not-a-backup');
    writeFileSync(join(dataDir, 'backups', 'stray-file'), 'x');
    rmSync(foreign, { recursive: true, force: true });
    expect(listBackups(dataDir)).toHaveLength(1);
    pruneBackups(dataDir, 1);
    expect(existsSync(join(dataDir, 'backups', 'stray-file'))).toBe(true);
  });
});

describe('maybeRunDailyBackup', () => {
  it('runs once per calendar day', () => {
    expect(maybeRunDailyBackup(db, { dataDir, now: noon })).toBe(true);
    expect(maybeRunDailyBackup(db, { dataDir, now: noon + 3_600_000 })).toBe(false);
    // Next day → runs again.
    expect(maybeRunDailyBackup(db, { dataDir, now: noon + 24 * 3_600_000 })).toBe(true);
    expect(readdirSync(join(dataDir, 'backups'))).toHaveLength(2);
  });

  it('waits for 04:00 local', () => {
    const twoAm = new Date(2026, 6, 20, 2, 0, 0).getTime();
    expect(maybeRunDailyBackup(db, { dataDir, now: twoAm })).toBe(false);
  });

  it('is a no-op when disabled', () => {
    expect(maybeRunDailyBackup(db, { dataDir, now: noon, enabled: false })).toBe(false);
  });
});
