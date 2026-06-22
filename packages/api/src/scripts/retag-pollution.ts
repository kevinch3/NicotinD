/**
 * Re-tag "low-hanging fruit" pollution — mis-tagged REAL music the cleanup pass
 * deliberately keeps (it never deletes recoverable albums). Recovers the correct
 * artist/album from data already in the row, with no external lookup:
 *
 *   • watermark album under a real artist  →  drop the watermark → single titled by track
 *       (e.g. "RÜFÜS DU SOL / ftpdjemilio.com / Innerbloom" → single "Innerbloom")
 *   • numeric-artist mis-split w/ "YYYY - Artist - Album" title  →  parse & MERGE
 *       (e.g. "101 / 1968 - Astor Piazzolla - MARÍA DE BUENOS AIRES" → one Piazzolla album)
 *
 *   bun run packages/api/src/scripts/retag-pollution.ts            # dry run
 *   bun run packages/api/src/scripts/retag-pollution.ts --apply    # write corrections
 *
 * Each correction goes through the existing `applyMetadataFix`: it persists a
 * **reversible** override in `library_metadata_overrides` (so a full rescan
 * reproduces it) AND re-points the canonical tables immediately — merging the
 * fragments that collapse onto the same corrected album id, and pruning the
 * orphaned numeric/junk artist rows. Files are NOT moved (songId stays stable);
 * the DB/UI become correct, the on-disk folder is tidied later by a reorg pass.
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_CONFIG.
 */

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { collectRetagTargets } from '../services/library-retag.js';
import { applyMetadataFix } from '../services/metadata-fix.js';
import { auditLibrary } from '../services/library-audit.js';

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
  const logPath = join(dataDir, 'retag-pollution.log');

  const targets = collectRetagTargets(db);
  console.log(`\nretag-pollution ${apply ? '(APPLY)' : '(dry run)'} — ${targets.length} albums to re-tag\n`);

  const byReason = new Map<string, number>();
  for (const t of targets) byReason.set(t.plan.reason, (byReason.get(t.plan.reason) ?? 0) + 1);
  for (const [r, n] of byReason) console.log(`  ${String(n).padStart(4)}  ${r}`);

  console.log('\nPlanned corrections (first 25):');
  for (const t of targets.slice(0, 25)) {
    const req = t.plan.request;
    const to = [req.artist && `artist=“${req.artist}”`, req.album && `album=“${req.album}”`, req.year && `year=${req.year}`]
      .filter(Boolean)
      .join(', ');
    console.log(`  • [${t.artist} — ${t.album}]  →  ${to}`);
  }

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write the corrections.\n');
    return;
  }

  let applied = 0;
  for (const t of targets) {
    const res = applyMetadataFix(db, t.albumId, t.plan.request);
    if (res) {
      applied++;
      appendFileSync(
        logPath,
        `${new Date().toISOString()}\t${t.plan.reason}\t${t.artist} — ${t.album}\t→\t${res.artist} — ${res.album} (${res.year ?? ''})\n`,
      );
    }
  }
  console.log(`\n✅ Applied ${applied}/${targets.length} corrections. Log: ${logPath}`);
  console.log(`High-severity findings now: ${auditLibrary(db).highSeverityCount}`);
}

main();
