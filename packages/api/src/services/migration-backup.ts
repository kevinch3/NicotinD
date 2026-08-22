/**
 * A snapshot of the database taken immediately before a schema migration.
 *
 * Distinct from the daily backup (`services/backup.ts`) in when it runs, where
 * it lands, how long it is kept, and what happens when it fails. Rationale in
 * docs/backup-restore.md "Pre-migration snapshots".
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import { backupsRoot } from './backup.js';
// Reused rather than redeclared — this structural type is already duplicated
// between system.ts and library-import.service.ts; a third copy is not the fix.
import type { StatfsFn } from './library-import.service.js';

const log = createLogger('migration-backup');

/**
 * Nested under the daily backups root, which keeps it out of that rotation for
 * free: `listBackups` filters on `/^nicotind-\d{8}-\d{6}$/`, so this directory
 * is invisible to it and therefore to `pruneBackups`. A pre-migration snapshot
 * must not evict a daily one, nor rotate out on a 7-day clock — the upgrade it
 * protects may not be noticed as bad for weeks.
 */
export const MIGRATION_BACKUPS_SUBDIR = 'pre-migrate';

/** Rare by construction — one per schema version bump, not one per day. */
const DEFAULT_KEEP = 3;

/** Headroom over the live DB size before a snapshot is attempted. */
const SIZE_HEADROOM = 1.15;

const NAME_RE = /^v\d+-to-v\d+-\d{8}-\d{6}(-\d+)?$/;

export interface MigrationBackupResult {
  /** Absolute path to the snapshot directory. */
  dir: string;
  name: string;
  sizeBytes: number;
}

export interface MigrationBackupDeps {
  dataDir: string;
  fromVersion: number;
  toVersion: number;
  now?: number;
  keepCount?: number;
  /** Injected for tests; defaults to node:fs statfsSync. */
  statfs?: StatfsFn;
}

export function migrationBackupsRoot(dataDir: string): string {
  return join(backupsRoot(dataDir), MIGRATION_BACKUPS_SUBDIR);
}

/**
 * `NICOTIND_BACKUP=off` deliberately does NOT suppress this.
 *
 * That flag means "stop filling my disk with daily snapshots". This is a safety
 * net for an irreversible operation that runs at most once per version bump —
 * a different thing, so it gets a different switch rather than inheriting one
 * whose meaning does not fit.
 */
export function migrationBackupEnabled(env = process.env): boolean {
  return env.NICOTIND_MIGRATION_BACKUP?.trim().toLowerCase() !== 'off';
}

/**
 * A database with no tables has nothing to lose, so snapshotting it is pure
 * cost: a fresh install is at version 0 and would otherwise back up an empty
 * file on its very first boot — as would every e2e run and throwaway container.
 */
export function hasSomethingToLose(db: Database): boolean {
  const row = db
    .query<{ c: number }, []>(
      `SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .get();
  return (row?.c ?? 0) > 0;
}

function stamp(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * A directory name nothing else owns.
 *
 * The daily backup `rmSync`s its target first, so two runs in the same second
 * silently delete one another (`stampFor` is second-resolution). Deleting a
 * backup to make room for a backup is never right, so this suffixes instead.
 */
function freeName(root: string, base: string): string {
  if (!existsSync(join(root, base))) return base;
  for (let i = 2; i < 100; i++) {
    if (!existsSync(join(root, `${base}-${i}`))) return `${base}-${i}`;
  }
  throw new Error(`migration backup: cannot find a free name for ${base}`);
}

function dbSizeBytes(dataDir: string): number {
  try {
    return statSync(join(dataDir, 'nicotind.db')).size;
  } catch {
    return 0;
  }
}

function freeBytes(dataDir: string, statfs: StatfsFn): number | null {
  try {
    const st = statfs(dataDir);
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}

function dirSize(dir: string): number {
  let total = 0;
  for (const f of readdirSync(dir)) total += statSync(join(dir, f)).size;
  return total;
}

/** Delete the oldest snapshots beyond `keepCount`. Only touches our own names. */
export function pruneMigrationBackups(dataDir: string, keepCount: number): void {
  const root = migrationBackupsRoot(dataDir);
  if (!existsSync(root)) return;
  const stale = readdirSync(root)
    .filter((n) => NAME_RE.test(n) && statSync(join(root, n)).isDirectory())
    .sort()
    .reverse()
    .slice(Math.max(keepCount, 1));
  for (const name of stale) {
    rmSync(join(root, name), { recursive: true, force: true });
    log.info({ name }, 'pre-migration backup pruned');
  }
}

/**
 * Snapshot the database before migrating it. Throws rather than returning a
 * failure: the caller is about to run an irreversible schema change, and
 * proceeding without the net it just asked for is the one outcome nobody wants.
 * Operators who accept that risk set `NICOTIND_MIGRATION_BACKUP=off`.
 */
export function runMigrationBackup(db: Database, deps: MigrationBackupDeps): MigrationBackupResult {
  const { dataDir, fromVersion, toVersion } = deps;
  const now = deps.now ?? Date.now();
  const statfs = deps.statfs ?? (statfsSync as unknown as StatfsFn);

  // Preflight, so a full disk reads as "not enough room" instead of a partial
  // file and a mid-VACUUM ENOSPC.
  const need = Math.ceil(dbSizeBytes(dataDir) * SIZE_HEADROOM);
  const free = freeBytes(dataDir, statfs);
  if (free !== null && need > 0 && free < need) {
    throw new Error(
      `cannot snapshot the database before migrating: need ~${Math.ceil(need / 1e6)} MB free in ${dataDir}, ` +
        `have ${Math.floor(free / 1e6)} MB. Free space and restart, or set NICOTIND_MIGRATION_BACKUP=off ` +
        `to migrate without a snapshot (irreversible).`,
    );
  }

  const root = migrationBackupsRoot(dataDir);
  mkdirSync(root, { recursive: true });
  const name = freeName(root, `v${fromVersion}-to-v${toVersion}-${stamp(now)}`);
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  // VACUUM INTO, never copyFileSync: the connection is WAL, so the .db file
  // alone is not a consistent snapshot.
  db.run('VACUUM INTO ?', [join(dir, 'nicotind.db')]);
  const secrets = join(dataDir, 'secrets.json');
  if (existsSync(secrets)) copyFileSync(secrets, join(dir, 'secrets.json'));

  pruneMigrationBackups(dataDir, deps.keepCount ?? resolveKeep());
  const sizeBytes = dirSize(dir);
  log.info({ name, fromVersion, toVersion, sizeBytes }, 'pre-migration backup created');
  return { dir, name, sizeBytes };
}

function resolveKeep(): number {
  const env = Number(process.env.NICOTIND_MIGRATION_BACKUP_KEEP);
  return Number.isInteger(env) && env > 0 ? env : DEFAULT_KEEP;
}
