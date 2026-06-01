/**
 * Backfill relative_path for completed_downloads rows that predate the library
 * organizer (invisible to auto-playlist / album deletion / tombstoning).
 *
 *   bun run packages/api/src/scripts/backfill-untracked.ts            # dry run
 *   bun run packages/api/src/scripts/backfill-untracked.ts --apply    # write
 *
 * Matches rows to on-disk files by basename; only unambiguous (single) matches
 * are filled in. Env: NICOTIND_DATA_DIR, NICOTIND_MUSIC_DIR, NICOTIND_CONFIG.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { backfillRelativePaths } from '../services/untracked-backfill.js';

function expandHome(p: string): string {
  return p.startsWith('~') ? join(process.env.HOME ?? '/root', p.slice(1)) : p;
}

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

function main(): void {
  const apply = process.argv.includes('--apply');
  const { dataDir, musicDir } = loadConfig();
  const dbPath = join(dataDir, 'nicotind.db');

  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}. Run nicotind at least once first.`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readwrite: true });
  db.run('PRAGMA busy_timeout = 5000');

  console.log(`Mode      : ${apply ? 'APPLY (writing)' : 'DRY RUN (no changes)'}`);
  console.log(`Music dir : ${musicDir}`);
  console.log(`Database  : ${dbPath}\n`);

  const { matched, ambiguous, unresolved } = backfillRelativePaths(db, musicDir, { apply });

  console.log(
    `\nDone (${apply ? 'applied' : 'dry run'}). matched=${matched} ambiguous=${ambiguous} unresolved=${unresolved}`,
  );
  if (!apply && matched > 0) {
    console.log('\nRe-run with --apply to write these relative paths.');
  }
}

if (import.meta.main) {
  main();
}
