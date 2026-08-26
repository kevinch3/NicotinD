/**
 * Library health report — the curation-pass dashboard (issue #734): coverage
 * metrics, bounded worst-first worklists and a remediation hint per dimension.
 * A *dashboard*, not a gate: always exits 0 (`audit-library.ts` stays the
 * DB+disk gate that fails on HIGH findings).
 *
 *   bun run packages/api/src/scripts/library-health.ts             # human table
 *   bun run packages/api/src/scripts/library-health.ts --json      # machine output
 *   bun run packages/api/src/scripts/library-health.ts --sample=25 # deeper worklists
 *
 * Read-only. Env: NICOTIND_DATA_DIR, NICOTIND_CONFIG.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { expandHome } from '@nicotind/core';
import { libraryHealth } from '../services/library-health.js';

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
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const sampleArg = args.find((a) => a.startsWith('--sample='))?.slice('--sample='.length);
  const sampleSize = sampleArg ? Number(sampleArg) : undefined;

  const dbPath = join(loadDataDir(), 'nicotind.db');
  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}. Run nicotind at least once first.`);
    process.exit(2);
  }
  const db = new Database(dbPath, { readonly: true });
  const report = libraryHealth(db, Number.isFinite(sampleSize) ? { sampleSize } : {});

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const t = report.totals;
  const d = report.dimensions;
  console.log(`\nLibrary health — ${dbPath}`);
  console.log(
    `  ${t.artists} artists · ${t.albums} albums (${t.visibleAlbums} visible) · ${t.songs} songs\n`,
  );
  const rows: Array<[string, string]> = [
    [
      'audit',
      `${d.audit.metric.high} high · ${d.audit.metric.medium} medium · ${d.audit.metric.low} low`,
    ],
    [
      'fragments',
      `${d.fragments.metric.duplicateAlbums} dup-album clusters · ${d.fragments.metric.misSplitAlbums} mis-split`,
    ],
    [
      'album covers',
      `${d.albumCovers.metric.missing} of ${d.albumCovers.metric.visible} missing canonical art`,
    ],
    [
      'artist portraits',
      `${d.artistPortraits.metric.missing} of ${d.artistPortraits.metric.visible} missing`,
    ],
    ['genres', `${d.genres.metric.missing} of ${d.genres.metric.songs} songs unresolved`],
    ['years', `${d.years.metric.missing} of ${d.years.metric.visibleAlbums} albums missing`],
    [
      'classification',
      `${d.classification.metric.visibleUnknown} visible unknown · ${d.classification.metric.oversized} oversized`,
    ],
    [
      'format cohesion',
      `${d.formatCohesion.metric.mixedFormatAlbums} mixed-format · ${d.formatCohesion.metric.lowBitrateAlbums} low-bitrate · ${d.formatCohesion.metric.losslessSongs} lossless left`,
    ],
    [
      'completeness',
      `${d.completeness.metric.confirmedIncomplete} confirmed incomplete · ${d.completeness.metric.suspected} suspected (advisory)`,
    ],
    ['lyrics', `${d.lyrics.metric.withLyrics} of ${d.lyrics.metric.songs} songs`],
    ['flags', `${d.flags.metric.open} open`],
  ];
  for (const [name, value] of rows) console.log(`  ${name.padEnd(17)} ${value}`);
  console.log('\n  --json for worklists + remediation hints per dimension.\n');
}

main();
