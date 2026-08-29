import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySchema } from '../db.js';
import { mutateSongGenre, parseGenreList } from './song-genre-mutate.js';
import { getGenreOverride, applyGenreOverride, buildOverrideIndex } from './genre-overrides.js';
import { loadGenreSets, setSongGenres } from './genre-split.js';

let db: Database;
let musicDir: string;
const relPath = 'Al Fredo/Singles/Luna, Agua, Tierra, Sol.opus';

/** Stands in for what a rescan reads off the file: the tag genre and nothing else. */
function tagSaysOnly(genre: string): void {
  setSongGenres(db, 'song-1', [genre]);
}

/** What `buildLibrary` would resolve for this song on the next scan. */
function whatARescanWouldResolve(tagGenres: string[]): string[] {
  const row = getGenreOverride(db, 'song', 'song-1');
  return applyGenreOverride(
    buildOverrideIndex(row ? [row] : []),
    { songId: 'song-1', albumKey: '', artistKey: '' },
    tagGenres,
  );
}

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, cover_art, song_count, duration, year, synced_at)
     VALUES ('album-1', 'Singles', 'Al Fredo', 'artist-1', 'album-1', 1, 210, NULL, 0)`,
  );
  db.run(
    `INSERT INTO library_songs
      (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, synced_at)
     VALUES ('song-1', 'album-1', 'Luna, Agua, Tierra, Sol', 'Al Fredo', 'artist-1', 210,
       '${relPath}', 1000, 128, 'opus', 'audio/ogg', '2026-08-01', 0)`,
  );
  musicDir = mkdtempSync(join(tmpdir(), 'nicotind-sgm-'));
  mkdirSync(join(musicDir, 'Al Fredo/Singles'), { recursive: true });
  writeFileSync(join(musicDir, relPath), 'not-really-audio');
});
afterEach(() => {
  db.close();
  rmSync(musicDir, { recursive: true, force: true });
});

describe('parseGenreList', () => {
  it('splits on ; , and | and collapses whitespace', () => {
    expect(parseGenreList('Cumbia Pop; Latin , Tropical|  Folk ')).toEqual([
      'Cumbia Pop',
      'Latin',
      'Tropical',
      'Folk',
    ]);
  });

  it('is empty for nothing usable', () => {
    expect(parseGenreList(undefined)).toEqual([]);
    expect(parseGenreList('  ;; , ')).toEqual([]);
  });
});

// Issue #762. The reported symptom was a curated genre reverting to "Music" —
// a generic value embedded in the file tag — after a rescan the curator did not
// run. `append` (the DEFAULT) wrote only `library_song_genres`, which the
// scanner rebuilds from the tag, so nothing durable outranked it.
describe('mutateSongGenre — durability across a rescan', () => {
  it('append writes an override row, so a rescan cannot revert it', async () => {
    tagSaysOnly('Music');

    const result = await mutateSongGenre(db, {}, 'song-1', { genre: 'Cumbia Pop' });
    expect(result.ok).toBe(true);

    const row = getGenreOverride(db, 'song', 'song-1');
    expect(row).not.toBeNull();
    expect(row?.genres).toEqual(['Cumbia Pop']);
    expect(row?.mode).toBe('append');
    expect(row?.source).toBe('user');

    // The scanner re-reads "Music" off the tag and re-applies the override on
    // top. Before the fix this resolved to ['Music'] and the curation was lost.
    expect(whatARescanWouldResolve(['Music'])).toEqual(['Cumbia Pop', 'Music']);
  });

  it('replace writes an override that drops the tag genres entirely', async () => {
    tagSaysOnly('Relief Records');

    await mutateSongGenre(db, {}, 'song-1', { genre: 'Techno', mode: 'replace' });

    expect(getGenreOverride(db, 'song', 'song-1')?.mode).toBe('replace');
    expect(whatARescanWouldResolve(['Relief Records'])).toEqual(['Techno']);
  });

  it('a second append accumulates instead of discarding the first', async () => {
    // The override row is keyed (scope, key) and upserts, so storing only the
    // latest call's genres would silently drop everything decided before it.
    await mutateSongGenre(db, {}, 'song-1', { genre: 'Cumbia Pop' });
    await mutateSongGenre(db, {}, 'song-1', { genre: 'Tropical' });

    expect(getGenreOverride(db, 'song', 'song-1')?.genres).toEqual(['Cumbia Pop', 'Tropical']);
  });

  it('does not duplicate a genre already curated, whatever its casing', async () => {
    await mutateSongGenre(db, {}, 'song-1', { genre: 'Cumbia Pop' });
    await mutateSongGenre(db, {}, 'song-1', { genre: 'cumbia  pop' });

    expect(getGenreOverride(db, 'song', 'song-1')?.genres).toEqual(['Cumbia Pop']);
  });

  it('an append onto a song already under replace keeps it under replace', async () => {
    // The curator claimed this song's genre set. Appending must not hand
    // authority back to the file tag.
    await mutateSongGenre(db, {}, 'song-1', { genre: 'Techno', mode: 'replace' });
    await mutateSongGenre(db, {}, 'song-1', { genre: 'Tech House' });

    const row = getGenreOverride(db, 'song', 'song-1');
    expect(row?.mode).toBe('replace');
    expect(row?.genres).toEqual(['Techno', 'Tech House']);
    expect(whatARescanWouldResolve(['Relief Records'])).toEqual(['Techno', 'Tech House']);
  });

  it('mirrors the resolved set into library_song_genres straight away', async () => {
    tagSaysOnly('Music');
    await mutateSongGenre(db, {}, 'song-1', { genre: 'Cumbia Pop' });

    // The UI must not have to wait for a scan to agree with the write.
    expect(loadGenreSets(db, ['song-1']).get('song-1')).toEqual(['Cumbia Pop', 'Music']);
  });
});

// The other half of #762: the tag write's boolean was discarded and its
// rejection swallowed, so `{ok: true}` came back whether or not anything
// reached the file.
describe('mutateSongGenre — the tag write reports its outcome', () => {
  it('reports true when the tag mirror lands', async () => {
    const result = await mutateSongGenre(db, { musicDir, writeTags: async () => true }, 'song-1', {
      genre: 'Cumbia Pop',
    });
    expect(result).toMatchObject({ ok: true, tagWritten: true });
  });

  it('reports false when the tag write fails — and keeps the curation', async () => {
    const result = await mutateSongGenre(db, { musicDir, writeTags: async () => false }, 'song-1', {
      genre: 'Cumbia Pop',
    });
    expect(result).toMatchObject({ ok: true, tagWritten: false });
    // The override is the durability mechanism, so a failed mirror is
    // reportable but not fatal.
    expect(getGenreOverride(db, 'song', 'song-1')?.genres).toEqual(['Cumbia Pop']);
  });

  it('reports false rather than throwing when the writer rejects', async () => {
    const result = await mutateSongGenre(
      db,
      {
        musicDir,
        writeTags: async () => {
          throw new Error('ffmpeg exploded');
        },
      },
      'song-1',
      { genre: 'Cumbia Pop' },
    );
    expect(result).toMatchObject({ ok: true, tagWritten: false });
  });

  it('reports null when no tag write was attempted at all', async () => {
    const result = await mutateSongGenre(db, {}, 'song-1', { genre: 'Cumbia Pop' });
    expect(result).toMatchObject({ ok: true, tagWritten: null });
  });
});

describe('mutateSongGenre — refusals', () => {
  it('rejects an empty genre', async () => {
    expect(await mutateSongGenre(db, {}, 'song-1', { genre: '  ' })).toEqual({
      ok: false,
      error: 'genre is required',
      status: 400,
    });
  });

  it('rejects an unknown song', async () => {
    expect(await mutateSongGenre(db, {}, 'nope', { genre: 'Techno' })).toEqual({
      ok: false,
      error: 'Song not found',
      status: 404,
    });
  });
});
