/**
 * Every song-id-keyed table is either carried across an id change, or exempt
 * on the record.
 *
 * why a gate: `library_songs.id` is `sha1(path)`, so a rename, a move or a
 * re-encode re-mints it — and there are **no foreign keys** on `song_id`,
 * deliberately, because a cascade would delete listening history on a routine
 * rescan. Nothing errors when a table is missed. Rows just stop matching, which
 * is how #259 produced dangling playlist rows and how 30% of song-scope genre
 * overrides were found orphaned on prod.
 *
 * The denominator is read from the **live schema** rather than restated here:
 * `applySchema` into an in-memory DB, then `pragma_table_info` over every
 * table. A table added next month is therefore in the denominator the moment it
 * exists, whether or not anyone remembered this file — which is the whole point
 * (docs/quality-gates.md, "a gate must assert its own denominator").
 *
 * Checked both ways, so a stale entry is an error too: a registry naming a
 * table or column the schema no longer has is as broken as a missed one.
 */
import { Database } from 'bun:sqlite';
import { applySchema } from '../packages/api/src/db.js';
import {
  SONG_CARRY_TABLES,
  SONG_CARRY_EXEMPT,
} from '../packages/api/src/services/song-curation-carry.js';

/** Columns that hold a `library_songs.id`. Name-based, and that is a limit. */
const SONG_ID_COLUMN = /^(song_id|seed_song_id|candidate_song_id|song_path)$/;

interface Found {
  table: string;
  column: string;
}

function schemaSongColumns(): Found[] {
  const db = new Database(':memory:');
  applySchema(db);
  const tables = db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all()
    .map((r) => r.name);

  const found: Found[] = [];
  for (const table of tables) {
    const cols = db
      .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`)
      .all()
      .map((c) => c.name);
    for (const column of cols) if (SONG_ID_COLUMN.test(column)) found.push({ table, column });
  }
  db.close();
  return found.sort((a, b) => (a.table + a.column).localeCompare(b.table + b.column));
}

function main(): void {
  const found = schemaSongColumns();
  const key = (f: Found) => `${f.table}.${f.column}`;
  const carried = new Map(SONG_CARRY_TABLES.map((e) => [key(e), e]));
  const exempt = new Map(SONG_CARRY_EXEMPT.map((e) => [key(e), e]));

  const problems: string[] = [];

  // Fail on what cannot be classified, rather than passing it silently.
  for (const f of found) {
    const k = key(f);
    if (carried.has(k) && exempt.has(k)) {
      problems.push(`${k} is in BOTH the carry and exempt lists — pick one`);
    } else if (!carried.has(k) && !exempt.has(k)) {
      problems.push(
        `${k} holds a song id but is neither carried nor exempt.\n` +
          `    An id re-mint will orphan it silently — there is no FK to catch it.\n` +
          `    Add it to SONG_CARRY_TABLES, or to SONG_CARRY_EXEMPT with a reason,\n` +
          `    in packages/api/src/services/song-curation-carry.ts`,
      );
    }
  }

  // The other direction: a stale entry is a lie about what is protected.
  const inSchema = new Set(found.map(key));
  for (const e of [...SONG_CARRY_TABLES, ...SONG_CARRY_EXEMPT]) {
    if (!inSchema.has(key(e))) {
      problems.push(`${key(e)} is registered but no longer exists in the schema — remove it`);
    }
  }

  for (const e of [...SONG_CARRY_TABLES, ...SONG_CARRY_EXEMPT]) {
    if (!e.why.trim()) problems.push(`${key(e)} has no reason recorded`);
  }

  // Print what was examined, so a shrinking denominator is visible.
  console.log(
    `Song-carry coverage: ${found.length} song-id column(s) in the schema — ` +
      `${SONG_CARRY_TABLES.length} carried, ${SONG_CARRY_EXEMPT.length} exempt.`,
  );
  console.log(
    '  (library_genre_overrides is carried explicitly: its column is `key`, not `song_id`,' +
      ' so a name-based sweep cannot see it.)',
  );

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
}

main();
