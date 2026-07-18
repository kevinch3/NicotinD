/**
 * Library fragmentation audit (read-only) — flags "all tracks are present but
 * the album doesn't surface in search / the grid" defects and prints a fix plan
 * for each.
 *
 *   bun run packages/api/src/scripts/check-fragments.ts
 *
 * Same set of detectors as `GET /api/library/fragments` (admin) and the Admin
 * panel — this script is the offline counterpart for spot-checks and CI gates.
 * Exits non-zero when any fragmentation is found, so a scheduled run can alert.
 *
 * Detected classes (see docs/library-scanner.md "Fragmentation diagnostic"):
 *
 *   1. **Duplicate albums** — same `library_albums` row group key under distinct
 *      album-artist spellings. Fix: alias the artist spellings via the
 *      artist-identity modal (admin) or `library_artist_aliases`, then run
 *      `POST /api/library/sync`.
 *   2. **Hidden by classification** — a row exists but the default Albums grid
 *      (`classification = 'album'`) hides it. Fix: PATCH the album's
 *      classification via the curator or unhide via the row menu.
 *   3. **Mis-split clusters** — ≥3 one-track singles sharing a title.
 *      Existing `checkMisSplitAlbums` re-emitted; fix pathway: the per-singles
 *      cleanup (see docs/library-audit.md).
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_MUSIC_DIR, NICOTIND_CONFIG.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { checkFragments, type FragmentReport } from '../services/library-fragments.js';

function expandHome(p: string): string {
  return p.startsWith('~') ? join(process.env.HOME ?? '/root', p.slice(1)) : '';
}

function loadConfig(): { dataDir: string } {
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
  return { dataDir };
}

function renderReport(r: FragmentReport): string {
  const lines: string[] = [];
  lines.push('Library fragmentation diagnostic');
  lines.push('=================================');
  lines.push('');
  lines.push(
    `  duplicate-albums (same release across artist spellings) : ${r.totals.duplicateAlbums}`,
  );
  lines.push(
    `  hidden-by-classification (rows the default grid omits)  : ${r.totals.hiddenByClassification}`,
  );
  lines.push(
    `  mis-split albums (one-track-per-title clusters)        : ${r.totals.misSplitAlbums}`,
  );
  lines.push('');

  if (r.duplicateAlbums.length > 0) {
    lines.push('--- Duplicate albums ---');
    lines.push('Each cluster is the same release under distinct artist spellings.');
    lines.push(
      'Fix: alias the spellings via Admin → Artist Identity → "merge into", then run a rescan.',
    );
    lines.push('');
    for (const c of r.duplicateAlbums) {
      lines.push(
        `  • "${c.displayTitle}"  (${c.memberIds.length} rows, ${c.totalSongs} tracks total)`,
      );
      for (const s of c.artistSpellings) {
        lines.push(`      - "${s.name}" (${s.occurrences} album${s.occurrences === 1 ? '' : 's'})`);
      }
    }
    lines.push('');
  }

  if (r.hiddenByClassification.length > 0) {
    lines.push('--- Hidden by classification ---');
    lines.push(
      "Rows the default Albums grid (`classification = 'album'`) suppresses. Reclassification or unhiding puts them back.",
    );
    lines.push('');
    for (const h of r.hiddenByClassification) {
      lines.push(
        `  • [${h.reason}] "${h.name}" — ${h.artist}  (classification=${h.classification}, hidden=${h.hidden})`,
      );
    }
    lines.push('');
  }

  if (r.misSplitAlbums.length > 0) {
    lines.push('--- Mis-split albums ---');
    for (const f of r.misSplitAlbums) {
      lines.push(`  • ${f.message}`);
    }
    lines.push('');
  }

  if (r.ok) {
    lines.push('OK: no fragmentation detected.');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const { dataDir } = loadConfig();
  const dbPath = join(dataDir, 'nicotind.db');
  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}. Run nicotind at least once first.`);
    process.exit(1);
  }
  const db = new Database(dbPath, { readonly: true });
  db.run('PRAGMA busy_timeout = 5000');
  try {
    const report = checkFragments(db);
    if (process.argv.includes('--json')) {
      process.stdout.write(JSON.stringify(report, null, 2));
      process.stdout.write('\n');
    } else {
      process.stdout.write(renderReport(report));
      process.stdout.write('\n');
    }
    process.exit(report.ok ? 0 : 1);
  } finally {
    db.close();
  }
}

// Only run as a CLI entrypoint — importing this module must not trigger a sweep.
if (import.meta.main) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
