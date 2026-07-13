/**
 * Seed (or re-seed) the system-curated, globally-visible playlists from the
 * local library — "Latin Beats", "2000s Essentials", etc. Each is materialized
 * into a consumable, ~40-track list (per-artist cap so no single act dominates),
 * marked `kind='curated'` (global + read-only through the per-user API), and
 * pointed at its designed gradient cover (`/playlist-covers/<slug>.svg`).
 *
 *   bun run packages/api/src/scripts/seed-curated-playlists.ts             # dry run
 *   bun run packages/api/src/scripts/seed-curated-playlists.ts --apply     # write
 *
 * Idempotent: a curated playlist is matched by (kind='curated', name); on
 * re-apply its songs are replaced and cover/description refreshed, so re-running
 * after the library grows refreshes the lists in place (no duplicates). The
 * owning user_id is the first admin (a NOT NULL provenance owner — visibility is
 * driven by `kind`, not ownership). Run from the repo root.
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_CONFIG.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  CURATED_PLAYLISTS,
  selectCuratedTracks,
  expandGenreWhere,
  type CandidateRow,
  type CuratedPlaylistDef,
} from '../services/curated-playlists.js';
import { upsertCuratedPlaylist } from '../services/auto-playlists.service.js';

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

/** Pick candidate rows for a def, then narrow to a consumable, capped list. */
function selectForDef(db: Database, def: CuratedPlaylistDef): string[] {
  const rows = db
    .query<CandidateRow, []>(
      `SELECT s.id AS id, s.artist AS artist
         FROM library_songs s
        WHERE s.hidden = 0 AND (${expandGenreWhere(def.where)})`,
    )
    .all();
  // Deterministic per-playlist seed so re-runs are stable but lists differ.
  const seed = def.slug.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
  return selectCuratedTracks(rows, {
    targetSize: def.targetSize,
    maxPerArtist: def.maxPerArtist,
    seed,
  });
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
  // Ensure the cover_art/kind columns exist even if the running server predates
  // the migration (applySchema is idempotent: CREATE IF NOT EXISTS + safe ALTERs).
  if (apply) applySchema(db);

  const admin = db
    .query<
      { id: string },
      []
    >("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1")
    .get();
  if (!admin) {
    console.error('No admin user found — cannot seed curated playlists.');
    process.exit(2);
  }

  console.log(`\nseed-curated-playlists ${apply ? '(APPLY)' : '(dry run)'}\n`);

  const plans = CURATED_PLAYLISTS.map((def) => ({ def, songIds: selectForDef(db, def) }));
  for (const { def, songIds } of plans) {
    const short = songIds.length < def.targetSize ? ` (target ${def.targetSize}, artist-thin)` : '';
    console.log(`  • ${def.name.padEnd(24)} ${String(songIds.length).padStart(3)} tracks${short}`);
  }

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write.\n');
    return;
  }

  const now = Date.now();
  const seedOne = db.transaction((def: CuratedPlaylistDef, songIds: string[]) => {
    upsertCuratedPlaylist(
      db,
      admin.id,
      { name: def.name, description: def.description, slug: def.slug },
      songIds,
      now,
    );
  });

  for (const { def, songIds } of plans) seedOne(def, songIds);
  console.log(`\nSeeded ${plans.length} curated playlists for admin ${admin.id}.\n`);
}

main();
