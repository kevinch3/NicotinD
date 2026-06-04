/**
 * One-shot backfill: reads every row from completed_downloads, groups by
 * directory, and runs the CompilationTagger over each group — exactly the
 * same logic that fires for new downloads, applied retroactively.
 *
 * Usage:
 *   bun run packages/api/src/scripts/backfill-compilation-tags.ts
 *
 * Respects the same env vars / config file as the main server:
 *   NICOTIND_DATA_DIR, NICOTIND_MUSIC_DIR, NICOTIND_CONFIG
 */

import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { initDatabase } from '../db.js';
import { CompilationTagger } from '../services/compilation-tagger.js';
import type { CompletedDownloadFile } from '../services/path-inference.js';

// ── Config loading (mirrors main.ts) ────────────────────────────────────────

function expandHome(p: string): string {
  return p.startsWith('~') ? join(process.env.HOME ?? '/root', p.slice(1)) : p;
}

function loadMinimalConfig(): { dataDir: string; musicDir: string | undefined } {
  let fileConfig: Record<string, unknown> = {};
  const configPath = resolve(process.env.NICOTIND_CONFIG ?? 'config/default.yml');
  try {
    fileConfig = (parse(readFileSync(configPath, 'utf-8')) ?? {}) as Record<string, unknown>;
  } catch {
    // no config file — rely on env vars
  }

  const dataDir = expandHome(
    process.env.NICOTIND_DATA_DIR ?? (fileConfig.dataDir as string | undefined) ?? '~/.nicotind',
  );
  const musicDir = process.env.NICOTIND_MUSIC_DIR ?? (fileConfig.musicDir as string | undefined);

  return { dataDir, musicDir: musicDir ? expandHome(musicDir) : undefined };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { dataDir, musicDir } = loadMinimalConfig();

  if (!musicDir) {
    console.error(
      'Error: musicDir is not configured. Set NICOTIND_MUSIC_DIR or musicDir in config/default.yml.',
    );
    process.exit(1);
  }

  console.log(`Data dir : ${dataDir}`);
  console.log(`Music dir: ${musicDir}`);

  const db = initDatabase(dataDir);

  // Read all completed downloads and group by directory
  const rows = db
    .query<
      { username: string; directory: string; filename: string; relative_path: string | null },
      []
    >('SELECT username, directory, filename, relative_path FROM completed_downloads ORDER BY directory')
    .all();

  if (rows.length === 0) {
    console.log('No completed downloads found in database. Nothing to do.');
    return;
  }

  const groups = new Map<string, CompletedDownloadFile[]>();
  for (const row of rows) {
    const file: CompletedDownloadFile = {
      username: row.username,
      directory: row.directory,
      filename: row.filename,
      relativePath: row.relative_path ?? undefined,
    };
    const group = groups.get(row.directory) ?? [];
    group.push(file);
    groups.set(row.directory, group);
  }

  // Inject directoryFileCount (derived from our own DB records per directory)
  for (const files of groups.values()) {
    const count = files.length;
    for (const f of files) {
      f.directoryFileCount = count;
    }
  }

  console.log(`Found ${rows.length} files across ${groups.size} directories.`);

  const tagger = new CompilationTagger({ musicDir });

  let processed = 0;
  for (const [directory, files] of groups) {
    if (files.length < 2) continue;
    console.log(`  [${++processed}/${groups.size}] ${directory} (${files.length} files)`);
    await tagger.tagCompletedFolders(files);
  }

  console.log(`\nDone. Processed ${processed} director${processed === 1 ? 'y' : 'ies'}.`);
  console.log('Run a Navidrome library scan to pick up the updated tags.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
