/**
 * A snapshot of the database taken by the deploy, immediately before it
 * replaces the running server (docs/backup-restore.md "Pre-deploy snapshots").
 *
 * Schema changes run on boot and most of them are additive ones the
 * pre-migration snapshot never sees (`SCHEMA_VERSION` only moves for run-once
 * steps), and a downgrade boots an older server against the newer schema with
 * a warning only. So the one point a rollback can return to cleanly is "just
 * before this deploy", and only the deploy knows when that is.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import { backupsRoot } from './backup.js';
import type { StatfsFn } from './disk-space.js';
import {
  hasSomethingToLose,
  snapshotDatabase,
  stamp,
  type MigrationBackupResult,
} from './migration-backup.js';

const log = createLogger('pre-deploy-snapshot');

/** Nested under the backups root, invisible to the daily rotation (like `pre-migrate`). */
export const PRE_DEPLOY_SUBDIR = 'pre-deploy';

/** One per deploy — frequent — so fewer are kept than there are deploys in a busy day. */
const DEFAULT_KEEP = 5;

const NAME_RE = /^pre-deploy-[\w.-]+-\d{8}-\d{6}(-\d+)?$/;

export function preDeployRoot(dataDir: string): string {
  return join(backupsRoot(dataDir), PRE_DEPLOY_SUBDIR);
}

/** Delete the oldest pre-deploy snapshots beyond `keep`. Only touches our own names. */
export function prunePreDeploySnapshots(dataDir: string, keep: number): void {
  const root = preDeployRoot(dataDir);
  if (!existsSync(root)) return;
  const byAge = readdirSync(root)
    .filter((n) => NAME_RE.test(n) && statSync(join(root, n)).isDirectory())
    .map((n) => ({ n, t: statSync(join(root, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { n } of byAge.slice(Math.max(keep, 1))) {
    rmSync(join(root, n), { recursive: true, force: true });
    log.info({ name: n }, 'pre-deploy snapshot pruned');
  }
}

export interface PreDeployDeps {
  dataDir: string;
  /** What is about to be deployed, for the directory name (`v1.2.3`, `edge`). */
  target: string;
  now?: number;
  keep?: number;
  statfs?: StatfsFn;
}

/**
 * Snapshot, or null when there is nothing to lose (no database yet, or one
 * with no tables — a fresh host's first deploy). Throws on failure: the deploy
 * aborts rather than replace the server without the snapshot it asked for.
 */
export function runPreDeploySnapshot(deps: PreDeployDeps): MigrationBackupResult | null {
  const { dataDir } = deps;
  const dbPath = join(dataDir, 'nicotind.db');
  if (!existsSync(dbPath)) return null;
  const db = new Database(dbPath);
  try {
    if (!hasSomethingToLose(db)) return null;
    const safeTarget = deps.target.replace(/[^\w.-]/g, '_') || 'unknown';
    const result = snapshotDatabase(db, {
      dataDir,
      root: preDeployRoot(dataDir),
      baseName: `pre-deploy-${safeTarget}-${stamp(deps.now ?? Date.now())}`,
      ...(deps.statfs ? { statfs: deps.statfs } : {}),
      onNoRoom: (needMb, haveMb) =>
        `cannot snapshot the database before deploying: need ~${needMb} MB free in ${dataDir}, ` +
        `have ${haveMb} MB. Free space and re-run the deploy.`,
    });
    prunePreDeploySnapshots(dataDir, deps.keep ?? DEFAULT_KEEP);
    log.info({ name: result.name, sizeBytes: result.sizeBytes }, 'pre-deploy snapshot created');
    return result;
  } finally {
    db.close();
  }
}
