/**
 * Backfill missing album years **offline** — from song tags, album-folder names,
 * and the existing `mb-cache.json` (no Lidarr / live MusicBrainz needed). The
 * gap-filling counterpart to optimize-metadata (which needs a live Lidarr).
 *
 *   bun run packages/api/src/scripts/backfill-years.ts             # dry run (tag+folder)
 *   bun run packages/api/src/scripts/backfill-years.ts --apply     # write tag+folder years
 *   bun run packages/api/src/scripts/backfill-years.ts --mb-cache  # also use mb-cache (see caveat)
 *
 * Sources, highest-confidence first: **tag** (the file's own year) and **folder**
 * (year in the album folder name — reliable for comps) are trustworthy and on by
 * default. **mb-cache** is opt-in (`--mb-cache`): the cached recording→release
 * mapping often points at a reissue, so its year can be a reissue date (e.g.
 * "Chocolate Starfish" → 2024 not 2000). It's reversible + logged, but spot-check.
 *
 * Each year is written through the reversible `applyMetadataFix` (an override in
 * `library_metadata_overrides` + the canonical `year` columns), so it survives a
 * full rescan even when the file tag itself has no year. Only albums currently
 * missing a year are touched; artist/album are unchanged so no id re-mints.
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_CONFIG.
 */

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { applyMetadataFix } from '../services/metadata-fix.js';
import {
  pickAlbumYear,
  folderYear,
  mbCacheKey,
  mbCacheYear,
  type YearSource,
} from '../services/year-backfill.js';

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
  const includeMb = process.argv.includes('--mb-cache');
  const dataDir = loadDataDir();
  const dbPath = join(dataDir, 'nicotind.db');
  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}.`);
    process.exit(2);
  }
  const db = apply ? new Database(dbPath) : new Database(dbPath, { readonly: true });

  // Load the MB recording cache if present (offline source 3, opt-in).
  let mbCache: Record<string, unknown> = {};
  const mbPath = join(dataDir, 'mb-cache.json');
  if (includeMb && existsSync(mbPath)) {
    try {
      mbCache = JSON.parse(readFileSync(mbPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      /* ignore a corrupt cache */
    }
  }

  const albums = db
    .query<
      { id: string; name: string; artist: string },
      []
    >('SELECT id, name, artist FROM library_albums WHERE hidden = 0 AND (year IS NULL OR year <= 1)')
    .all();

  const bySource = new Map<YearSource, number>();
  const picks: { id: string; label: string; year: number; source: YearSource }[] = [];

  for (const a of albums) {
    const songs = db
      .query<
        { title: string; year: number | null; path: string },
        [string]
      >('SELECT title, year, path FROM library_songs WHERE album_id = ?')
      .all(a.id);
    const tagYears = songs.map((s) => s.year).filter((y): y is number => typeof y === 'number' && y > 1);
    const folder = (songs[0]?.path ?? '').split('/')[1] ?? '';
    const mbYears: number[] = [];
    for (const s of songs) {
      const y = mbCacheYear(mbCache[mbCacheKey(a.artist, s.title)]);
      if (y) mbYears.push(y);
    }
    const pick = pickAlbumYear({ tagYears, folderYear: folderYear(folder), mbYears });
    if (!pick) continue;
    bySource.set(pick.source, (bySource.get(pick.source) ?? 0) + 1);
    picks.push({ id: a.id, label: `${a.artist} — ${a.name}`, year: pick.year, source: pick.source });
  }

  console.log(
    `\nbackfill-years ${apply ? '(APPLY)' : '(dry run)'} — ${picks.length}/${albums.length} missing-year albums recoverable offline\n`,
  );
  for (const [s, n] of bySource) console.log(`  ${String(n).padStart(4)}  ${s}`);
  console.log('\nSample (first 25):');
  for (const p of picks.slice(0, 25)) console.log(`  • ${p.label}  →  ${p.year}  (${p.source})`);

  if (!apply) {
    const hint = includeMb
      ? 'mb-cache years can be reissue dates — spot-check.'
      : 'add --mb-cache to recover ~195 more from the local cache (reissue-year caveat).';
    console.log(
      `\nDry run only. Re-run with --apply to write. ${albums.length - picks.length} not recoverable here — ${hint}\n`,
    );
    return;
  }

  const logPath = join(dataDir, 'backfill-years.log');
  let applied = 0;
  for (const p of picks) {
    const res = applyMetadataFix(db, p.id, { year: p.year, source: 'manual' });
    if (res) {
      applied++;
      appendFileSync(logPath, `${new Date().toISOString()}\t${p.source}\t${p.year}\t${p.label}\n`);
    }
  }
  console.log(`\n✅ Applied ${applied}/${picks.length} years. Log: ${logPath}`);
  console.log(
    `${albums.length - picks.length} albums still need a live Lidarr/MusicBrainz lookup (run optimize-metadata once Lidarr is configured).\n`,
  );
}

main();
