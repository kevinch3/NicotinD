/**
 * Genre reclassification — propose → review → apply, same human-gated shape as
 * resolve-artist-identity.ts --aliases. Deterministic rules (splitGenres) run
 * automatically at scan time; everything they can't fix safely (no-separator
 * concatenations like "RockPunk", junk values like "Other", punctuation
 * variants, unresolved "/" joins) is *proposed* here as `library_genre_aliases`
 * rows for a human to review, then applied and picked up by the next rescan.
 *
 *   bun run packages/api/src/scripts/reclassify-genres.ts --propose            # print proposals
 *   bun run packages/api/src/scripts/reclassify-genres.ts --propose --out f.json
 *   bun run packages/api/src/scripts/reclassify-genres.ts --apply f.json       # write reviewed rows
 *
 * Env: NICOTIND_DATA_DIR (falls back to config dataDir).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import {
  proposeGenreAliases,
  buildKnownFromRaw,
  type GenreAliasProposal,
} from '../services/genre-split.js';

function expandHome(p: string): string {
  return p.startsWith('~') ? join(process.env.HOME ?? '/root', p.slice(1)) : p;
}

function dataDir(): string {
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

/**
 * Post-split vocabulary with counts. Prefers library_song_genres (populated
 * once a post-upgrade scan ran — leftovers there are exactly what the rules
 * could not fix); falls back to library_songs.genre pre-first-rescan.
 */
function loadVocabulary(db: Database): Array<{ value: string; count: number }> {
  try {
    const fromJoin = db
      .query<{ value: string; count: number }, []>(
        `SELECT genre AS value, COUNT(*) AS count FROM library_song_genres GROUP BY genre`,
      )
      .all();
    if (fromJoin.length > 0) return fromJoin;
  } catch {
    // Table absent (db predates the multi-genre schema) — fall through.
  }
  const raw = db
    .query<{ genre: string; count: number }, []>(
      `SELECT genre, COUNT(*) AS count FROM library_songs
       WHERE genre IS NOT NULL AND genre <> '' GROUP BY genre`,
    )
    .all();
  // Pre-rescan rows may still be joined strings — split them the same way the
  // scanner's in-batch vocabulary pass does, so proposals target real parts.
  const counts = new Map<string, number>();
  const display = buildKnownFromRaw(raw.map((r) => r.genre));
  for (const r of raw) {
    for (const part of r.genre.split(/[;,|]/)) {
      const key = part.trim().replace(/\s+/g, ' ').toLowerCase();
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + r.count);
    }
  }
  return [...counts.entries()].map(([key, count]) => ({ value: display.get(key) ?? key, count }));
}

function main(): void {
  const args = process.argv.slice(2);
  const db = new Database(join(dataDir(), 'nicotind.db'));

  if (args.includes('--propose')) {
    const proposals = proposeGenreAliases(loadVocabulary(db));
    proposals.sort((a, b) => b.count - a.count);
    const outIdx = args.indexOf('--out');
    const json = JSON.stringify(proposals, null, 2);
    if (outIdx >= 0 && args[outIdx + 1]) {
      writeFileSync(args[outIdx + 1]!, json);
      console.log(`${proposals.length} proposals written to ${args[outIdx + 1]}`);
    } else {
      console.log(json);
      console.error(`\n${proposals.length} proposals. Review, edit, then --apply <file>.`);
    }
    return;
  }

  const applyIdx = args.indexOf('--apply');
  if (applyIdx >= 0 && args[applyIdx + 1]) {
    const proposals = JSON.parse(readFileSync(args[applyIdx + 1]!, 'utf-8')) as GenreAliasProposal[];
    const stmt = db.prepare(
      `INSERT INTO library_genre_aliases (alias, canonical, source, created_at)
       VALUES (?, ?, 'user', ?)
       ON CONFLICT(alias) DO UPDATE SET canonical = excluded.canonical`,
    );
    const now = Date.now();
    db.transaction(() => {
      for (const p of proposals) stmt.run(p.alias, p.canonical, now);
    })();
    console.log(`${proposals.length} alias rows written. Run a full rescan to rebuild genres.`);
    return;
  }

  console.error('Usage: reclassify-genres.ts --propose [--out file.json] | --apply file.json');
  process.exit(1);
}

main();
