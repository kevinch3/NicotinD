/**
 * Reclaim the acquisition addon's stranded downloads (#1052).
 *
 *   bun run packages/api/src/scripts/reclaim-addon-downloads.ts            # dry run
 *   bun run packages/api/src/scripts/reclaim-addon-downloads.ts --apply    # delete
 *   bun run packages/api/src/scripts/reclaim-addon-downloads.ts --limit 50 --verbose
 *
 * The slskd addon downloaded into `<musicDir>/.downloads`, served the bytes to
 * core, and until #1052 never deleted them — 34 GB on kpc. New downloads are
 * freed when core releases the job; this clears what accumulated before that,
 * which no retention window reaches retroactively.
 *
 * It deletes a file **only** when the library provably holds the same recording:
 * matching title, duration within a couple of seconds, and the library's own
 * file still on disk. Title alone is not proof — on the real backlog it would
 * have deleted a 235 s "Una vez más" against library rows of 180/255/175/241 s.
 * Everything unproven is reported and left alone.
 *
 * Run it from the API container, which has ffprobe, the library DB and the
 * music dir. Env: NICOTIND_DATA_DIR, NICOTIND_MUSIC_DIR, NICOTIND_CONFIG.
 */
import { existsSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { AUDIO_EXTENSIONS, expandHome } from '@nicotind/core';
import {
  indexLibrary,
  judgeStrandedFile,
  type LibraryTrack,
  type ReclaimVerdict,
} from '../services/download-reclaim.js';

function loadConfig(): { dataDir: string; musicDir: string } {
  let fileConfig: Record<string, unknown> = {};
  const configPath = resolve(process.env.NICOTIND_CONFIG ?? 'config/default.yml');
  try {
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

function walk(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

function durationOf(absPath: string): number | null {
  const out = Bun.spawnSync([
    'ffprobe',
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    absPath,
  ]);
  const n = Number(String(out.stdout).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Basenames a still-running acquisition job is waiting on. Even a proven
 * duplicate is left alone while a live job names it: the job is the one thing
 * here that might still read the file, and it is about to finish anyway.
 */
function liveJobBasenames(db: Database): Set<string> {
  const rows = db
    .query<{ filename: string | null }, []>(
      `SELECT i.filename FROM acquisition_job_items i
       JOIN acquisition_jobs j ON j.id = i.job_id
       WHERE j.state = 'active' AND i.state IN ('queued', 'downloading', 'completed')`,
    )
    .all();
  const out = new Set<string>();
  for (const r of rows) {
    if (!r.filename) continue;
    const leaf = r.filename.replace(/\\/g, '/').split('/').pop();
    if (leaf) out.add(leaf.toLowerCase());
  }
  return out;
}

/** Remove folders the deletions emptied, never the root itself. */
function pruneEmptyDirs(root: string, dir: string): void {
  let cur = dir;
  for (;;) {
    const rel = relative(root, cur);
    if (!rel || rel.startsWith('..')) return;
    try {
      if (readdirSync(cur).length > 0) return;
      rmdirSync(cur);
    } catch {
      return;
    }
    cur = dirname(cur);
  }
}

const GB = 1024 ** 3;

function main(): void {
  const argv = process.argv;
  const apply = argv.includes('--apply');
  const verbose = argv.includes('--verbose');
  const limitArg = argv.indexOf('--limit');
  const limit = limitArg > -1 ? Number(argv[limitArg + 1]) : Infinity;

  const { dataDir, musicDir } = loadConfig();
  const dbPath = join(dataDir, 'nicotind.db');
  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}.`);
    process.exit(1);
  }
  const downloadsArg = argv.indexOf('--downloads');
  const downloadsDir =
    downloadsArg > -1 ? String(argv[downloadsArg + 1]) : join(musicDir, '.downloads');
  if (!existsSync(downloadsDir)) {
    console.log(`Nothing to do — ${downloadsDir} does not exist.`);
    return;
  }

  const db = new Database(dbPath, { readonly: true });
  const library = indexLibrary(
    db
      .query<LibraryTrack, []>(`SELECT title, duration, path FROM library_songs`)
      .all()
      .filter((t) => t.title && Number.isFinite(t.duration)),
  );
  const live = liveJobBasenames(db);

  console.log(`Mode      : ${apply ? 'APPLY (deleting)' : 'DRY RUN (no changes)'}`);
  console.log(`Downloads : ${downloadsDir}`);
  console.log(
    `Library   : ${library.size} distinct titles, ${live.size} files held by live jobs\n`,
  );

  const tally: Record<ReclaimVerdict['kind'], { n: number; bytes: number }> = {
    proven: { n: 0, bytes: 0 },
    'no-title-match': { n: 0, bytes: 0 },
    'duration-mismatch': { n: 0, bytes: 0 },
    'library-file-missing': { n: 0, bytes: 0 },
    unreadable: { n: 0, bytes: 0 },
  };
  let skippedLive = 0;
  let deleted = 0;
  let deletedBytes = 0;

  for (const abs of walk(downloadsDir)) {
    const base = abs.slice(abs.lastIndexOf('/') + 1);
    const ext = base.slice(base.lastIndexOf('.')).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(ext)) continue;
    if (live.has(base.toLowerCase())) {
      skippedLive += 1;
      continue;
    }

    let size = 0;
    try {
      size = statSync(abs).size;
    } catch {
      continue;
    }

    const verdict = judgeStrandedFile(base, durationOf(abs), library, (p) =>
      existsSync(join(musicDir, p)),
    );
    tally[verdict.kind].n += 1;
    tally[verdict.kind].bytes += size;

    if (verdict.kind !== 'proven') {
      if (verbose) console.log(`  keep  [${verdict.kind}] ${relative(downloadsDir, abs)}`);
      continue;
    }
    if (verbose || !apply) {
      console.log(`  free  ${relative(downloadsDir, abs)}  →  library has ${verdict.matched.path}`);
    }
    if (!apply || deleted >= limit) continue;
    try {
      unlinkSync(abs);
      pruneEmptyDirs(downloadsDir, dirname(abs));
      deleted += 1;
      deletedBytes += size;
    } catch (err) {
      console.error(`  FAILED to delete ${abs}: ${String(err)}`);
    }
  }

  const gb = (b: number) => (b / GB).toFixed(2);
  console.log('\nVerdicts:');
  for (const [kind, t] of Object.entries(tally)) {
    if (t.n)
      console.log(`  ${kind.padEnd(21)} ${String(t.n).padStart(5)} files  ${gb(t.bytes)} GB`);
  }
  if (skippedLive) console.log(`  held by a live job    ${String(skippedLive).padStart(5)} files`);

  if (apply) {
    console.log(`\nDeleted ${deleted} files, ${gb(deletedBytes)} GB.`);
  } else if (tally.proven.n > 0) {
    console.log(
      `\nDry run. ${tally.proven.n} files (${gb(tally.proven.bytes)} GB) are provably already in the library.`,
    );
    console.log('Read the list above, then re-run with --apply to delete exactly those.');
  }
}

if (import.meta.main) {
  main();
}
