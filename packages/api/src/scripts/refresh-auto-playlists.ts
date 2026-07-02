/**
 * Materialize (or refresh) the automated recipe-driven shelves into
 * `kind='curated'` playlists — "Late Night", "Workout", "Fresh This Week", etc.
 * These are normally refreshed once per ISO week in-process by the windowed
 * processor; this script is the ops/debug + first-rollout entry point.
 *
 *   bun run packages/api/src/scripts/refresh-auto-playlists.ts             # dry run
 *   bun run packages/api/src/scripts/refresh-auto-playlists.ts --apply     # write
 *
 * Idempotent (matches curated playlists by (kind='curated', name); replaces
 * songs + refreshes cover/description). Uses the current week's seed so the
 * lists match what the in-process refresh would produce. Run from the repo root.
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_CONFIG.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { refreshAutoPlaylists } from '../services/auto-playlists.service.js';

function expandHome(p: string): string {
  return p.startsWith('~') ? join(process.env.HOME ?? '/root', p.slice(1)) : p;
}

function loadDataDir(): string {
  let fileConfig: Record<string, unknown> = {};
  const configPath = resolve(process.env.NICOTIND_CONFIG ?? 'config/default.yml');
  try {
    fileConfig = (parse(readFileSync(configPath, 'utf-8')) ?? {}) as Record<string, unknown>;
  } catch {
    /* no config file */
  }
  return expandHome(
    process.env.NICOTIND_DATA_DIR ?? (fileConfig.dataDir as string | undefined) ?? '~/.nicotind',
  );
}

function main(): void {
  const apply = process.argv.includes('--apply');
  const dataDir = loadDataDir();
  const dbPath = join(dataDir, 'nicotind.db');
  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}.`);
    process.exit(2);
  }
  const db = apply ? new Database(dbPath) : new Database(dbPath, { readonly: true });
  if (apply) applySchema(db);

  console.log(`\nrefresh-auto-playlists ${apply ? '(APPLY)' : '(dry run)'}\n`);
  const results = refreshAutoPlaylists(db, Date.now(), { apply });
  for (const r of results) {
    console.log(`  • ${r.name.padEnd(24)} ${String(r.count).padStart(3)} tracks`);
  }
  console.log(
    apply
      ? `\nRefreshed ${results.length} automated playlists.\n`
      : '\nDry run only. Re-run with --apply to write.\n',
  );
}

main();
