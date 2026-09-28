import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listBackups } from './backup.js';
import {
  preDeployRoot,
  prunePreDeploySnapshots,
  runPreDeploySnapshot,
} from './pre-deploy-snapshot.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'nicotind-predeploy-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A real on-disk WAL database with a row in it, left open like the running server's. */
function liveDb(dataDir: string): Database {
  const db = new Database(join(dataDir, 'nicotind.db'), { create: true });
  db.run('PRAGMA journal_mode=WAL');
  db.run('CREATE TABLE t (x INTEGER)');
  db.run('INSERT INTO t VALUES (42)');
  return db;
}

const plentyOfSpace = () => ({ bsize: 4096, blocks: 1e9, bavail: 1e9 });
const noSpace = () => ({ bsize: 4096, blocks: 1e9, bavail: 0 });

describe('runPreDeploySnapshot', () => {
  it('snapshots the database a running server holds open, readable on its own', () => {
    const dataDir = tmp();
    const live = liveDb(dataDir);
    writeFileSync(join(dataDir, 'secrets.json'), '{"jwt":"s"}');

    const res = runPreDeploySnapshot({ dataDir, target: 'v1.2.3', statfs: plentyOfSpace });
    live.close();

    expect(res?.name).toMatch(/^pre-deploy-v1\.2\.3-\d{8}-\d{6}$/);
    const copy = new Database(join(res!.dir, 'nicotind.db'), { readonly: true });
    expect(copy.query<{ x: number }, []>('SELECT x FROM t').get()?.x).toBe(42);
    copy.close();
    expect(readdirSync(res!.dir).sort()).toEqual(['nicotind.db', 'secrets.json']);
  });

  it('is a no-op on a host with no database yet', () => {
    expect(
      runPreDeploySnapshot({ dataDir: tmp(), target: 'v1', statfs: plentyOfSpace }),
    ).toBeNull();
  });

  it('is a no-op on a database with nothing in it', () => {
    const dataDir = tmp();
    new Database(join(dataDir, 'nicotind.db'), { create: true }).close();
    expect(runPreDeploySnapshot({ dataDir, target: 'v1', statfs: plentyOfSpace })).toBeNull();
  });

  // The deploy must stop rather than replace the server without its snapshot.
  it('throws, naming the shortfall, when the disk cannot hold the snapshot', () => {
    const dataDir = tmp();
    liveDb(dataDir).close();
    expect(() => runPreDeploySnapshot({ dataDir, target: 'v1', statfs: noSpace })).toThrow(
      'before deploying',
    );
  });

  it('keeps its snapshots out of the daily rotation', () => {
    const dataDir = tmp();
    liveDb(dataDir).close();
    runPreDeploySnapshot({ dataDir, target: 'edge', statfs: plentyOfSpace });
    expect(listBackups(dataDir)).toEqual([]);
  });

  it('sanitizes the target into a safe directory name', () => {
    const dataDir = tmp();
    liveDb(dataDir).close();
    const res = runPreDeploySnapshot({ dataDir, target: '../../etc', statfs: plentyOfSpace });
    expect(res?.dir.startsWith(preDeployRoot(dataDir))).toBe(true);
  });
});

describe('prunePreDeploySnapshots', () => {
  it('keeps the newest N and never touches a name it did not write', () => {
    const dataDir = tmp();
    liveDb(dataDir).close();
    const made: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = runPreDeploySnapshot({
        dataDir,
        target: `v${i}`,
        now: Date.UTC(2026, 0, 1, 0, 0, i),
        keep: 99,
        statfs: plentyOfSpace,
      })!;
      utimesSync(r.dir, 1000 + i, 1000 + i);
      made.push(r.name);
    }
    const root = preDeployRoot(dataDir);
    rmSync(join(root, 'keep-me'), { force: true, recursive: true });
    writeFileSync(join(root, 'keep-me'), 'not ours');

    prunePreDeploySnapshots(dataDir, 2);
    expect(readdirSync(root).sort()).toEqual([made[2]!, made[3]!, 'keep-me'].sort());
  });
});
