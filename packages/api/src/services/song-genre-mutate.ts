/**
 * Song-genre mutation — extracted out of `POST /api/library/songs/:id/genre`
 * in routes/library.ts (issue #677), the third instance of the shape
 * services/library-deletion.ts (#232) and services/artist-identity-mutate.ts
 * (#339) already established: an MCP curator tool must run the *same* tested
 * write an HTTP request runs, never a second copy of the logic in routes/mcp.ts.
 *
 * `musicDir` is an explicit param rather than a closure, and `recordAudit` stays
 * caller-side — the HTTP route audits as the logged-in curator, the MCP tool as
 * `agent:<tokenId>` with a `(via MCP agent)` suffix.
 */
import { existsSync } from 'node:fs';
import type { Database } from 'bun:sqlite';
import { loadGenreSets, setSongGenres } from './genre-split.js';
import {
  applyGenreOverride,
  buildOverrideIndex,
  getGenreOverride,
  upsertGenreOverride,
  type GenreOverrideMode,
} from './genre-overrides.js';
import { writeAudioTags } from './audio-tags.js';
import { expandDir, resolveSongPath, isUnderMusicDir } from './song-path.js';

export interface SongGenreMutateDeps {
  musicDir?: string;
  /** Injectable for tests, mirroring `SongMetadataMutateDeps`. */
  writeTags?: (abs: string, tags: { genre: string }) => Promise<boolean>;
}

export interface SongGenreMutateBody {
  /** One genre, or a ';'/','/'|'-separated LIST, primary first. */
  genre?: string;
  /** 'append' (default) adds; 'replace' writes a song-scoped user override. */
  mode?: 'append' | 'replace';
}

export type SongGenreMutateResult =
  | {
      ok: true;
      genres: string[];
      /**
       * Whether the file's own genre tag was updated: `true`, `false` (the
       * write was attempted and failed), or `null` (not attempted — no
       * `musicDir`, or the file is missing / outside it).
       *
       * The result used to be `{ok: true}` either way, so a swallowed tag
       * failure was indistinguishable from a landed one (issue #762).
       */
      tagWritten: boolean | null;
    }
  | { ok: false; error: string; status: 400 | 404 };

/**
 * Split a caller-supplied genre string into the stored list shape. The separator
 * set is the scanner's own (`SEPARATORS`, genre-split.ts) so a curated genre stays
 * a value a rescan can reproduce — `append` mirrors the merged set back into the
 * file tag, so narrowing this to ';' would only move the shatter to the next scan
 * and leave an `& Country` fragment behind (issues #194, #913).
 */
export function parseGenreList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[;,|]/)
    .map((g) => g.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

/**
 * Apply a genre (or genre list, primary first) to one song: writes
 * `library_song_genres`, mirrors the primary into `library_songs`, refreshes the
 * `library_genres` counts, and mirrors the full set into the file's tag. Does
 * not record an audit entry — the caller does.
 */
export async function mutateSongGenre(
  db: Database,
  deps: SongGenreMutateDeps,
  songId: string,
  body: SongGenreMutateBody,
): Promise<SongGenreMutateResult> {
  const genres = parseGenreList(body.genre);
  if (genres.length === 0) return { ok: false, error: 'genre is required', status: 400 };

  const song = db
    .query<{ path: string }, [string]>(`SELECT path FROM library_songs WHERE id = ?`)
    .get(songId);
  if (!song) return { ok: false, error: 'Song not found', status: 404 };

  // BOTH modes write a song-scoped user override, because that row is the only
  // thing a rescan re-applies (`applyGenreOverride`, called from buildLibrary).
  // 'append' used to write only `library_song_genres`, which the scanner
  // rebuilds from the file tag — so a curated genre on a song whose tag held a
  // real-but-wrong value ("Music", a label name) was silently reverted by the
  // next scan (issue #762). The tag mirror below is a convenience for external
  // players; the override is the durability mechanism, in both modes.
  //
  // 'replace' (issue #187 A3) makes the curated genres the whole set.
  // 'append' keeps the tag's genres and adds to them, which is what an
  // automated detector wants — so the override stores only the CURATED
  // additions, accumulated across calls, never a snapshot of the tags as they
  // happened to read today.
  const prior = getGenreOverride(db, 'song', songId);
  const mode: GenreOverrideMode =
    // A song already under an explicit 'replace' decision stays there: the
    // curator has claimed its genre set, and appending to it must not silently
    // hand authority back to the file tag.
    body.mode === 'replace' || prior?.mode === 'replace' ? 'replace' : 'append';
  // An explicit 'replace' claims the whole set. Anything else accumulates onto
  // whatever the curator already decided, so a second append never discards the
  // first — the row is keyed (scope, key) and upserts, so storing only this
  // call's genres would quietly drop the earlier ones.
  const overrideGenres =
    body.mode === 'replace' ? genres : dedupeGenres([...(prior?.genres ?? []), ...genres]);

  const row = {
    scope: 'song',
    key: songId,
    genres: overrideGenres,
    source: 'user',
    mbid: null,
    confidence: null,
    status: 'applied',
    note: null,
    mode,
  } as const;
  upsertGenreOverride(db, { ...row });

  // Mirror what buildLibrary will compute on the next scan, so the UI and the
  // eventual scan agree instead of briefly disagreeing. Running the stored set
  // through the same `applyGenreOverride` the scanner uses is what keeps the
  // two from drifting.
  const stored = loadGenreSets(db, [songId]).get(songId) ?? [];
  const merged = applyGenreOverride(
    buildOverrideIndex([{ ...row }]),
    { songId, albumKey: '', artistKey: '' },
    stored,
  );
  setSongGenres(db, songId, merged);

  // The tag write's outcome is reported, not swallowed. It used to be
  // `.catch(() => false)` with the return value dropped, so `{ok: true}` came
  // back whether or not anything reached the file (issue #762).
  let tagWritten: boolean | null = null;
  if (deps.musicDir) {
    const abs = resolveSongPath(expandDir(deps.musicDir), song.path);
    if (isUnderMusicDir(expandDir(deps.musicDir), abs) && existsSync(abs)) {
      tagWritten = await (deps.writeTags ?? writeAudioTags)(abs, {
        genre: merged.join('; '),
      }).catch(() => false);
    }
  }
  return { ok: true, genres: merged, tagWritten };
}

/** Case/whitespace-insensitive dedupe preserving first-seen order. */
function dedupeGenres(genres: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of genres) {
    const cleaned = g.trim().replace(/\s+/g, ' ');
    const k = cleaned.toLocaleLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(cleaned);
  }
  return out;
}
