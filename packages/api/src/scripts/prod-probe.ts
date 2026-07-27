/**
 * Production probe (STRICTLY read-only, developer tool) — answer the questions
 * that keep getting re-asked of the live database, without hand-rolling a
 * throwaway script each time.
 *
 *   # locally, against your dev DB
 *   bun run packages/api/src/scripts/prod-probe.ts --orphans
 *
 *   # against prod (kpc): ship this file into the container and run it there
 *   ssh kpc 'docker exec -i nicotind-nicotind-1 sh -lc "cat > /tmp/probe.ts && bun /tmp/probe.ts --jobs"' \
 *     < packages/api/src/scripts/prod-probe.ts
 *
 * Modes (combinable):
 *   --orphans     per-side-table row + orphan counts (rows whose song_id is gone)
 *   --jobs        acquisition jobs by state/stage, + item-state breakdown
 *   --transfers   hidden_transfers size (the removal fallback's backlog)
 *   --sql "<q>"   one-off read, forced read-only (see assertReadOnlySql)
 *   --json        emit JSON instead of the text tables
 *   --db <path>   override the database path
 *
 * WHY this exists: several issues in this repo ask for prod measurement before
 * implementation, and it repeatedly changed the answer — #262's stated root
 * cause was wrong (20 of 28 stranded items already had a row at their exact
 * path), and #259's apparent retention tension dissolved once the curator
 * tables measured at *zero* orphans. But every probe was a throwaway that
 * rediscovered the same boilerplate: the DB path, the readonly flag, and the
 * VACUUM INTO rule for replays. That boilerplate lives here now.
 *
 * SAFETY. This points at production, so:
 *   - the handle is opened `{ readonly: true }` with no flag to disable it;
 *   - `--sql` accepts a single SELECT/WITH/PRAGMA statement and nothing else;
 *   - nothing here writes, ever. A replay that must write belongs on a
 *     `VACUUM INTO` copy — see docs/prod-inspection.md.
 *
 * Env: NICOTIND_DATA_DIR (default /data/nicotind in-container).
 * See docs/prod-inspection.md.
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Per-song side tables worth measuring. This list is deliberately WIDER than
 * the pruner's `ORPHAN_TABLES`: the point of a probe is to measure tables you
 * would never prune (lyrics are network-sourced and user-editable) because
 * that measurement is what tells you whether the prune policy is right. Keeping
 * them separate is intentional — this is the *measure* set, not the *prune* set.
 */
export const ORPHAN_PROBE_TABLES: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'library_embeddings', column: 'song_id' },
  { table: 'library_song_analysis_failures', column: 'song_id' },
  { table: 'library_song_genres', column: 'song_id' },
  { table: 'library_song_artists', column: 'song_id' },
  { table: 'library_lyrics', column: 'song_id' },
  { table: 'playlist_songs', column: 'song_id' },
];

const MUTATING_KEYWORDS = [
  'insert',
  'update',
  'delete',
  'drop',
  'alter',
  'create',
  'replace',
  'truncate',
  'vacuum',
  'attach',
  'detach',
  'reindex',
  'begin',
  'commit',
  'rollback',
];

/** Strip SQL comments so a keyword check can't be fooled by a commented decoy. */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/**
 * Blank out string literals before scanning. A literal cannot execute, so
 * `WHERE title = 'update me'` is a perfectly good read — without this it trips
 * the keyword check, which is a real nuisance when grepping the library. A
 * `;` inside a literal likewise isn't a statement separator.
 */
function stripSqlLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/**
 * Throw unless `sql` is a single read-only statement.
 *
 * The real enforcement is the read-only connection; this is the fast, legible
 * second layer that fails with a useful message instead of an SQLITE_READONLY.
 * Comments are stripped *first* — a guard that checks the leading keyword
 * before stripping reads `-- SELECT 1\nDELETE …` as a SELECT.
 */
export function assertReadOnlySql(sql: string): void {
  const cleaned = stripSqlLiterals(stripSqlComments(sql)).trim().replace(/;\s*$/, '');
  if (!cleaned) throw new Error('--sql: empty statement');

  if (cleaned.includes(';')) {
    throw new Error('--sql accepts a single statement (no ";" separators)');
  }

  const leading = cleaned.match(/^([a-z]+)/i)?.[1].toLowerCase();
  if (!leading || !['select', 'with', 'pragma'].includes(leading)) {
    throw new Error(`--sql must start with SELECT, WITH or PRAGMA (got "${leading ?? '?'}")`);
  }

  // `PRAGMA foo = bar` writes; the query form does not.
  if (leading === 'pragma' && /=/.test(cleaned)) {
    throw new Error('--sql: PRAGMA may not assign (use the query form)');
  }

  // Whole-word match only, so `deleted_at` / `FROM updates` stay readable.
  for (const kw of MUTATING_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(cleaned)) {
      throw new Error(`--sql contains the mutating keyword "${kw}"`);
    }
  }
}

/** Open the database read-only. There is deliberately no writable variant. */
export function openReadOnlyDb(path: string): Database {
  return new Database(path, { readonly: true });
}

export interface OrphanCount {
  table: string;
  rows: number;
  orphans: number;
}

function tableExists(db: Database, table: string): boolean {
  return !!db.query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(table);
}

/** Row + orphan counts per side table. Tables absent from the schema are skipped. */
export function probeOrphans(db: Database): OrphanCount[] {
  const out: OrphanCount[] = [];
  if (!tableExists(db, 'library_songs')) return out;

  for (const { table, column } of ORPHAN_PROBE_TABLES) {
    if (!tableExists(db, table)) continue;
    const rows = (db.query(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
    const orphans = (
      db
        .query(
          `SELECT COUNT(*) c FROM ${table} t
           WHERE NOT EXISTS (SELECT 1 FROM library_songs s WHERE s.id = t.${column})`,
        )
        .get() as { c: number }
    ).c;
    out.push({ table, rows, orphans });
  }
  return out;
}

export interface JobCount {
  state: string;
  stage: string;
  count: number;
}

/** Acquisition jobs grouped by state+stage — the #262 "stranded at scanning" view. */
export function probeJobs(db: Database): JobCount[] {
  if (!tableExists(db, 'acquisition_jobs')) return [];
  return db
    .query(
      `SELECT state, stage, COUNT(*) count FROM acquisition_jobs
       GROUP BY state, stage ORDER BY count DESC`,
    )
    .all() as JobCount[];
}

export interface TransferCounts {
  hiddenTransfers: number;
}

/** Size of the `hidden_transfers` fallback — should trend to zero after #265. */
export function probeTransfers(db: Database): TransferCounts {
  if (!tableExists(db, 'hidden_transfers')) return { hiddenTransfers: 0 };
  return {
    hiddenTransfers: (db.query('SELECT COUNT(*) c FROM hidden_transfers').get() as { c: number }).c,
  };
}

function resolveDbPath(argv: string[]): string {
  const flag = argv.indexOf('--db');
  if (flag !== -1 && argv[flag + 1]) return argv[flag + 1];
  const dataDir = process.env.NICOTIND_DATA_DIR ?? '/data/nicotind';
  return join(dataDir, 'nicotind.db');
}

function renderRows(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return '  (none)';
  const cols = Object.keys(rows[0]);
  const width = (c: string) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length));
  const line = (cells: string[]) =>
    '  ' + cells.map((cell, i) => cell.padEnd(width(cols[i]))).join('  ');
  return [line(cols), line(cols.map((c) => '-'.repeat(width(c))))]
    .concat(rows.map((r) => line(cols.map((c) => String(r[c] ?? '')))))
    .join('\n');
}

function main(): void {
  const argv = process.argv.slice(2);
  const dbPath = resolveDbPath(argv);

  if (!existsSync(dbPath)) {
    console.error(`No database at ${dbPath} (set NICOTIND_DATA_DIR or pass --db).`);
    process.exit(1);
  }

  const sqlFlag = argv.indexOf('--sql');
  const sql = sqlFlag !== -1 ? argv[sqlFlag + 1] : undefined;
  const modes = {
    orphans: argv.includes('--orphans'),
    jobs: argv.includes('--jobs'),
    transfers: argv.includes('--transfers'),
  };
  const any = modes.orphans || modes.jobs || modes.transfers || sql;
  if (!any) {
    console.error(
      'Usage: prod-probe.ts [--orphans] [--jobs] [--transfers] [--sql "SELECT …"] [--json] [--db <path>]',
    );
    process.exit(1);
  }

  // Validate before opening, so a bad --sql fails instantly — and as one clean
  // line, not a stack trace: this is usually read through an ssh + docker exec
  // pipe where a trace buries the actual reason.
  if (sql !== undefined) {
    try {
      assertReadOnlySql(sql);
    } catch (err) {
      console.error(`refused: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  const db = openReadOnlyDb(dbPath);
  const asJson = argv.includes('--json');
  const result: Record<string, unknown> = {};

  try {
    if (modes.orphans) result.orphans = probeOrphans(db);
    if (modes.jobs) result.jobs = probeJobs(db);
    if (modes.transfers) result.transfers = probeTransfers(db);
    if (sql !== undefined) result.sql = db.query(sql).all();

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`# prod-probe — ${dbPath} (read-only)\n`);
    for (const [key, value] of Object.entries(result)) {
      console.log(`## ${key}`);
      console.log(
        Array.isArray(value)
          ? renderRows(value as Array<Record<string, unknown>>)
          : renderRows([value as Record<string, unknown>]),
      );
      console.log('');
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  main();
}
