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
import { appendSongGenres, loadGenreSets, setSongGenres } from './genre-split.js';
import { applyGenreOverride, buildOverrideIndex, upsertGenreOverride } from './genre-overrides.js';
import { writeAudioTags } from './audio-tags.js';
import { expandDir, resolveSongPath, isUnderMusicDir } from './song-path.js';

export interface SongGenreMutateDeps {
  musicDir?: string;
}

export interface SongGenreMutateBody {
  /** One genre, or a ';'/','/'|'-separated LIST, primary first. */
  genre?: string;
  /** 'append' (default) adds; 'replace' writes a song-scoped user override. */
  mode?: 'append' | 'replace';
}

export type SongGenreMutateResult =
  { ok: true; genres: string[] } | { ok: false; error: string; status: 400 | 404 };

/** Split a caller-supplied genre string into the stored list shape. */
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

  // Default 'append': a detected genre adds to, never clobbers, the song's
  // other genres. 'replace' (issue #187 A3) writes a song-scoped user override
  // so the set's PRIMARY becomes these genres and stays that way across
  // rescans; the tag mirror below is then a convenience for external players,
  // not the durability mechanism.
  let merged: string[];
  if (body.mode === 'replace') {
    upsertGenreOverride(db, {
      scope: 'song',
      key: songId,
      genres,
      source: 'user',
      mbid: null,
      confidence: null,
      status: 'applied',
      note: null,
      mode: 'replace',
    });
    // Mirror what buildLibrary will compute on the next scan (override first,
    // then the tag genres it doesn't already carry) so the UI and the eventual
    // scan agree instead of briefly disagreeing.
    const existing = loadGenreSets(db, [songId]).get(songId) ?? [];
    merged = applyGenreOverride(
      buildOverrideIndex([
        {
          scope: 'song',
          key: songId,
          genres,
          source: 'user',
          mbid: null,
          confidence: null,
          status: 'applied',
          note: null,
        },
      ]),
      { songId, albumKey: '', artistKey: '' },
      existing,
    );
    setSongGenres(db, songId, merged);
  } else {
    merged = appendSongGenres(db, songId, genres);
  }

  if (deps.musicDir) {
    const abs = resolveSongPath(expandDir(deps.musicDir), song.path);
    if (isUnderMusicDir(expandDir(deps.musicDir), abs) && existsSync(abs)) {
      await writeAudioTags(abs, { genre: merged.join('; ') }).catch(() => false);
    }
  }
  return { ok: true, genres: merged };
}
