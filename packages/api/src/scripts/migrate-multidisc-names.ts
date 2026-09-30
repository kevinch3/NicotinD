/**
 * Rename existing multi-disc tracks to the organizer's `D-NN - Title` shape,
 * carrying every song-id-keyed row across the re-minted ids (#1392).
 *
 *   bun run packages/api/src/scripts/migrate-multidisc-names.ts            # dry run
 *   bun run packages/api/src/scripts/migrate-multidisc-names.ts --apply    # snapshot, then rename
 *   bun run packages/api/src/scripts/migrate-multidisc-names.ts --revert <journal.jsonl>
 *
 * Dry run is the default and writes nothing. `--apply` and `--revert` take a
 * `VACUUM INTO` snapshot first and refuse to run without one. Env:
 * NICOTIND_DATA_DIR, NICOTIND_MUSIC_DIR, NICOTIND_CONFIG.
 * → docs/download-pipeline.md "Migrating existing multi-disc files"
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { expandHome } from '@nicotind/core';
import { reservedDirsFor } from '../services/library-paths.js';
import {
  applyRenames,
  countCarriedRows,
  planMultiDiscRenames,
  readJournal,
  revertRenames,
  stageRenames,
  type RenameRow,
} from '../services/multidisc-rename.js';

export interface MigrateOptions {
  dataDir: string;
  musicDir: string;
  mode: 'dry-run' | 'apply' | 'revert';
  journal?: string;
  log?: (line: string) => void;
  /** Injected so a test can pin the run's file names. */
  now?: () => Date;
}

export interface MigrateOutcome {
  planned: number;
  applied: number;
  unresolved: number;
  remaining: number;
  snapshot?: string;
  journal?: string;
  before?: Record<string, number>;
  after?: Record<string, number>;
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function snapshot(db: Database, dataDir: string, label: string): string {
  const dir = join(dataDir, 'backups');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `pre-multidisc-${label}.db`);
  if (existsSync(path)) throw new Error(`snapshot ${path} already exists`);
  db.run(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  if (!existsSync(path)) throw new Error(`snapshot ${path} was not written`);
  return path;
}

export function runMigration(opts: MigrateOptions): MigrateOutcome {
  const log = opts.log ?? ((l: string) => console.log(l));
  const dbPath = join(opts.dataDir, 'nicotind.db');
  if (!existsSync(dbPath)) throw new Error(`Database not found at ${dbPath}`);
  const db = new Database(
    dbPath,
    opts.mode === 'dry-run' ? { readonly: true } : { readwrite: true },
  );
  try {
    db.run('PRAGMA busy_timeout = 5000');
    const label = stamp((opts.now ?? (() => new Date()))());

    if (opts.mode === 'revert') {
      if (!opts.journal) throw new Error('--revert needs the journal path of the run to undo');
      const entries = readJournal(opts.journal);
      const snap = snapshot(db, opts.dataDir, `revert-${label}`);
      log(`Snapshot  : ${snap}`);
      const r = revertRenames(db, opts.musicDir, opts.journal);
      log(`Reverted ${r.applied}/${entries.length} rename(s). Journal: ${opts.journal}.revert`);
      return {
        planned: entries.length,
        applied: r.applied,
        unresolved: 0,
        remaining: entries.length - r.applied,
        snapshot: snap,
        journal: `${opts.journal}.revert`,
      };
    }

    const rows = () =>
      db.query<RenameRow, []>('SELECT id, path, disc, track, title FROM library_songs').all();
    const plan = planMultiDiscRenames(rows(), reservedDirsFor());
    const staged = stageRenames(plan.renames, opts.musicDir);

    for (const r of plan.renames)
      log(`rename  ${r.from}\n     →  ${r.to}   (${r.fromId} → ${r.toId})`);
    for (const s of plan.skipped) log(`skip    ${s.reason.padEnd(13)} ${s.path}`);
    for (const u of staged.unresolved) log(`BLOCKED ${u.state.padEnd(13)} ${u.from} → ${u.to}`);

    const before = countCarriedRows(
      db,
      plan.renames.map((r) => r.fromId),
    );
    const reasons: Record<string, number> = {};
    for (const s of plan.skipped) reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
    log('');
    log(`Mode              : ${opts.mode === 'apply' ? 'APPLY' : 'DRY RUN (nothing written)'}`);
    log(`Multi-disc folders: ${plan.multiDiscFolders}`);
    log(`Already D-NN      : ${plan.alreadyDone}`);
    log(
      `Planned renames   : ${plan.renames.length} (${plan.renames.filter((r) => r.suffixStripped).length} drop a " (N)" suffix)`,
    );
    log(`Skipped           : ${JSON.stringify(reasons)}`);
    log(
      `Staged            : ${JSON.stringify(countStates(staged.ready))}, unresolved ${staged.unresolved.length}`,
    );
    log(`Rows to carry     : ${JSON.stringify(before)}`);

    const outcome: MigrateOutcome = {
      planned: plan.renames.length,
      applied: 0,
      unresolved: staged.unresolved.length,
      remaining: plan.renames.length,
      before,
    };
    if (opts.mode === 'dry-run') {
      if (plan.renames.length > 0)
        log('\nRe-run with --apply to rename (a DB snapshot is taken first).');
      return outcome;
    }
    if (staged.unresolved.length > 0) {
      throw new Error(
        `${staged.unresolved.length} unresolved rename(s) — see BLOCKED lines; nothing written`,
      );
    }
    if (plan.renames.length === 0) return { ...outcome, remaining: 0 };

    outcome.snapshot = snapshot(db, opts.dataDir, `rename-${label}`);
    outcome.journal = join(opts.dataDir, 'backups', `multidisc-rename-${label}.jsonl`);
    log(`Snapshot          : ${outcome.snapshot}`);
    log(`Journal           : ${outcome.journal}`);
    const r = applyRenames(db, opts.musicDir, staged, outcome.journal, (done, total) => {
      if (done % 250 === 0 || done === total) log(`  ${done}/${total}`);
    });
    outcome.applied = r.applied;
    outcome.after = countCarriedRows(
      db,
      plan.renames.map((x) => x.toId),
    );
    outcome.remaining = planMultiDiscRenames(rows(), reservedDirsFor()).renames.length;
    log(`Carried rows after: ${JSON.stringify(outcome.after)}`);
    log(`Applied ${r.applied}; a re-plan finds ${outcome.remaining} left.`);
    return outcome;
  } finally {
    db.close();
  }
}

function countStates(list: readonly { state: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of list) out[s.state] = (out[s.state] ?? 0) + 1;
  return out;
}

function loadDirs(): { dataDir: string; musicDir: string } {
  let fileConfig: Record<string, unknown> = {};
  try {
    const configPath = resolve(process.env.NICOTIND_CONFIG ?? 'config/default.yml');
    fileConfig = (parse(readFileSync(configPath, 'utf-8')) ?? {}) as Record<string, unknown>;
  } catch {
    /* no config file */
  }
  const dataDir = expandHome(
    process.env.NICOTIND_DATA_DIR ?? (fileConfig.dataDir as string | undefined) ?? '~/.nicotind',
  );
  const musicDirRaw = process.env.NICOTIND_MUSIC_DIR ?? (fileConfig.musicDir as string | undefined);
  if (!musicDirRaw) throw new Error('musicDir not configured');
  return { dataDir, musicDir: expandHome(musicDirRaw) };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const revertIdx = argv.indexOf('--revert');
  const mode = revertIdx >= 0 ? 'revert' : argv.includes('--apply') ? 'apply' : 'dry-run';
  try {
    runMigration({
      ...loadDirs(),
      mode,
      journal: revertIdx >= 0 ? argv[revertIdx + 1] : undefined,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
