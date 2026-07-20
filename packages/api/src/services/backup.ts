/**
 * Scheduled + on-demand backups of NicotinD's stateful core (the Home
 * Assistant backup model, scoped to what actually needs saving): the SQLite
 * database — snapshotted online via `VACUUM INTO`, which is safe under WAL
 * with concurrent writers — plus `secrets.json`. Music files are deliberately
 * excluded (plain files; users rsync them).
 *
 * Backups land in `<dataDir>/backups/nicotind-<stamp>/` and are pruned to the
 * newest N. The daily guard (`maybeRunDailyBackup`) is driven from the
 * windowed processor's tick like `maybeRefreshAutoPlaylists`, keyed on a
 * `library_sync_state` marker — at most one backup per calendar day, taken at
 * the first tick after 04:00 local (or on boot later that day).
 *
 * Restore is manual by design (the server can't safely swap its own live DB):
 * stop the server, copy the backup's files back into the data dir, start.
 * See docs/backup-restore.md.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';

const log = createLogger('backup');

const DAY_MARKER = 'backup_last_day';
const DEFAULT_KEEP = 7;
const BACKUP_NAME_RE = /^nicotind-\d{8}-\d{6}$/;
/** Earliest local hour a scheduled daily backup may run (HA backs up at night). */
const EARLIEST_HOUR = 4;

export interface BackupInfo {
  /** Directory name, e.g. `nicotind-20260720-041502`. */
  name: string;
  /** Creation time (ms epoch, from the directory mtime). */
  createdAt: number;
  /** Total size of the backup's files in bytes. */
  sizeBytes: number;
  /** Files inside the backup (relative names). */
  files: string[];
}

export interface BackupOptions {
  dataDir: string;
  /** Newest backups to keep after a run (default 7). */
  keepCount?: number;
  /** Injected clock for tests. */
  now?: number;
}

export function backupsRoot(dataDir: string): string {
  return join(dataDir, 'backups');
}

/** Explicit option wins, then `NICOTIND_BACKUP_KEEP`, then the default (7). */
function resolveKeepCount(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const env = Number(process.env.NICOTIND_BACKUP_KEEP);
  return Number.isInteger(env) && env > 0 ? env : DEFAULT_KEEP;
}

function stampFor(now: number): string {
  const d = new Date(now);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function infoFor(root: string, name: string): BackupInfo {
  const dir = join(root, name);
  const files = readdirSync(dir).sort();
  let sizeBytes = 0;
  for (const f of files) sizeBytes += statSync(join(dir, f)).size;
  return { name, createdAt: statSync(dir).mtimeMs, sizeBytes, files };
}

/** Create one backup now: DB snapshot (`VACUUM INTO`) + secrets copy, then prune. */
export function runBackup(db: Database, opts: BackupOptions): BackupInfo {
  const now = opts.now ?? Date.now();
  const root = backupsRoot(opts.dataDir);
  const name = `nicotind-${stampFor(now)}`;
  const dir = join(root, name);
  // VACUUM INTO refuses an existing target file; a fresh per-run directory
  // (second-resolution stamp) guarantees that outside of tests reusing `now`.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  db.run('VACUUM INTO ?', [join(dir, 'nicotind.db')]);
  const secrets = join(opts.dataDir, 'secrets.json');
  if (existsSync(secrets)) copyFileSync(secrets, join(dir, 'secrets.json'));
  pruneBackups(opts.dataDir, resolveKeepCount(opts.keepCount));
  const info = infoFor(root, name);
  log.info({ name, sizeBytes: info.sizeBytes }, 'backup created');
  return info;
}

/** All backups, newest first. */
export function listBackups(dataDir: string): BackupInfo[] {
  const root = backupsRoot(dataDir);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => BACKUP_NAME_RE.test(n) && statSync(join(root, n)).isDirectory())
    .sort()
    .reverse()
    .map((n) => infoFor(root, n));
}

/** Delete the oldest backups beyond `keepCount`. Only touches dirs matching the backup name pattern. */
export function pruneBackups(dataDir: string, keepCount: number): void {
  const stale = listBackups(dataDir).slice(Math.max(keepCount, 1));
  for (const b of stale) {
    rmSync(join(backupsRoot(dataDir), b.name), { recursive: true, force: true });
    log.info({ name: b.name }, 'backup pruned');
  }
}

function readMarker(db: Database, key: string): string | null {
  const row = db
    .query<{ value: string }, [string]>('SELECT value FROM library_sync_state WHERE key = ?')
    .get(key);
  return row?.value ?? null;
}

function writeMarker(db: Database, key: string, value: string, now: number): void {
  db.run(
    `INSERT INTO library_sync_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, now],
  );
}

/**
 * Daily guard, safe to call every processor tick: runs at most one backup per
 * calendar day, no earlier than 04:00 local. Disabled by `NICOTIND_BACKUP=off`
 * (or `enabled: false` injected in tests). Returns true when a backup ran.
 */
export function maybeRunDailyBackup(
  db: Database,
  opts: BackupOptions & { enabled?: boolean },
): boolean {
  const enabled = opts.enabled ?? process.env.NICOTIND_BACKUP?.trim().toLowerCase() !== 'off';
  if (!enabled) return false;
  const now = opts.now ?? Date.now();
  if (new Date(now).getHours() < EARLIEST_HOUR) return false;
  const day = stampFor(now).slice(0, 8); // YYYYMMDD
  if (readMarker(db, DAY_MARKER) === day) return false;
  try {
    runBackup(db, { ...opts, now });
    writeMarker(db, DAY_MARKER, day, now);
    return true;
  } catch (err) {
    // Never let a backup failure break the processing tick; retried next tick.
    log.error({ err }, 'daily backup failed');
    return false;
  }
}
