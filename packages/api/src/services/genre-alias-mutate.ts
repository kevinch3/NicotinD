import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import { loadGenreContext, loadGenreSets, setSongGenres, splitGenres } from './genre-split.js';
import { parseGenreList } from './song-genre-mutate.js';

const log = createLogger('genre-alias-mutate');

export type GenreAliasResult =
  | { ok: false; error: string }
  | { ok: true; alias: string; canonical: string[]; songsUpdated: number };

/**
 * Upsert one `library_genre_aliases` row and apply it to the rows that already
 * carry the bad value.
 *
 * The alias table is the only genre store whose granularity matches an
 * artist-wide or catalogue-wide bad string: one row fixes every song carrying
 * it, expands one alias into many genres, and survives rescans without
 * rewriting files. It was reachable only from an admin CLI, so a curation
 * session facing a 44-song mistag (`Nueva CancióN`, all of Mercedes Sosa, all at
 * position 3) could only write 44 song-scoped overrides — the wrong shape for
 * the defect, because a newly-downloaded Sosa track arrives carrying the same
 * bad string with no override covering it (issue #949).
 *
 * An empty `canonical` is meaningful and supported: it drops a junk value
 * outright, which is what the table's `''` convention already means.
 */
export function upsertGenreAlias(
  db: Database,
  input: { alias: string; canonical: string; source?: string },
): GenreAliasResult {
  const alias = (input.alias ?? '').trim().replace(/\s+/g, ' ');
  if (!alias) return { ok: false, error: 'alias must be a non-empty raw genre value' };

  // The canonical side is a genre LIST, parsed the way every other curation
  // surface parses caller input — so an alias can never introduce a value a
  // rescan would re-split differently (#942).
  const canonical = parseGenreList(input.canonical ?? '');
  // Compared on the EXACT string, not `genreKey`: the key folds case and
  // accents, and the largest real instance of this defect class is precisely a
  // casing repair inside an accented name — `Nueva CancióN` → `Nueva Canción`,
  // 44 rows. A key comparison would call that a no-op and refuse it.
  if (canonical.length === 1 && canonical[0] === alias) {
    return { ok: false, error: 'canonical must differ from alias' };
  }

  db.run(
    `INSERT INTO library_genre_aliases (alias, canonical, source, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(alias) DO UPDATE SET canonical = excluded.canonical, source = excluded.source`,
    [alias, canonical.join(';'), input.source ?? 'user', Date.now()],
  );

  const songsUpdated = applyAliasToStoredRows(db, alias);
  log.info({ alias, canonical, songsUpdated }, 'genre alias upserted');
  return { ok: true, alias, canonical, songsUpdated };
}

/**
 * Re-split only the songs that actually carry `alias`.
 *
 * `backfillGenresFromAliases` re-splits the whole library, which is right for
 * the admin CLI's bulk pass and far too much for one curation call. Same
 * mechanism, narrowed to the rows the alias can possibly change.
 */
function applyAliasToStoredRows(db: Database, alias: string): number {
  const ctx = loadGenreContext(db);
  const ids = db
    .query<{ song_id: string }, [string]>(
      `SELECT DISTINCT song_id FROM library_song_genres WHERE genre = ? COLLATE NOCASE`,
    )
    .all(alias)
    .map((r) => r.song_id);
  if (ids.length === 0) return 0;

  let updated = 0;
  for (const [songId, genres] of loadGenreSets(db, ids)) {
    const next = splitGenres(genres.join(';'), ctx);
    if (next.length === genres.length && next.every((g, i) => g === genres[i])) continue;
    setSongGenres(db, songId, next);
    updated++;
  }
  return updated;
}
