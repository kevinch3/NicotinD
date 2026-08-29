/**
 * Direct unit coverage of the deletion service extracted out of
 * routes/library.ts (issue #232) — the route-level tests in
 * routes/library.test.ts already cover this exhaustively through HTTP; this
 * file exercises the same module directly so the MCP tools (issue #232) that
 * call it without going through Hono have a test surface of their own.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as realFsNamespace from 'node:fs';

const realFs = { ...realFsNamespace };

const fsState = new Map<string, boolean>();
const dirEntries = new Map<
  string,
  Array<{ name: string; isFile: boolean; isDirectory: boolean }>
>();

mock.module('node:fs', () => ({
  existsSync: (path: string) => fsState.get(path) ?? false,
  readdirSync: (path: string) =>
    (dirEntries.get(path) ?? []).map((entry) => ({
      name: entry.name,
      isFile: () => entry.isFile,
      isDirectory: () => entry.isDirectory,
    })),
  unlinkSync: mock((path: string) => {
    if (!fsState.get(path)) {
      throw new Error(`ENOENT: no such file or directory, unlink '${path}'`);
    }
    fsState.delete(path);
  }),
  rmSync: mock((path: string) => {
    fsState.delete(path);
    dirEntries.delete(path);
    const prefix = path.endsWith('/') ? path : `${path}/`;
    for (const key of [...fsState.keys()]) if (key.startsWith(prefix)) fsState.delete(key);
    for (const key of [...dirEntries.keys()]) if (key.startsWith(prefix)) dirEntries.delete(key);
  }),
  rmdirSync: mock((path: string) => {
    dirEntries.delete(path);
  }),
}));

afterAll(() => {
  mock.module('node:fs', () => realFs);
});

import { applySchema } from '../db.js';
import { ShareRescanScheduler } from './share-rescan-scheduler.js';

const sharedDb = new Database(':memory:');
applySchema(sharedDb);

mock.module('../db.js', () => ({
  getDatabase: () => sharedDb,
  applySchema,
}));

const { deleteAlbum, deleteOne } = await import('./library-deletion.js');

function seedSong(id: string, albumId: string, path: string): void {
  sharedDb.run('DELETE FROM library_songs WHERE id = ?', [id]);
  sharedDb.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, landed_at, synced_at)
     VALUES (?, ?, ?, 'Artist', 'art', 0, ?, 1000, 320, 'mp3', 'audio/mpeg', '2024-01-01', 1, 1)`,
    [id, albumId, id, path],
  );
}

function noopScheduler(): ShareRescanScheduler {
  return new ShareRescanScheduler(async () => {});
}

describe('deleteOne', () => {
  beforeEach(() => {
    fsState.clear();
    dirEntries.clear();
  });

  it('deletes the file and the canonical row', async () => {
    seedSong('s1', 'alb', '/music/Artist/Album/s1.mp3');
    fsState.set('/music/Artist/Album/s1.mp3', true);

    const result = await deleteOne(sharedDb, 's1', {
      musicDir: '/music',
      shareRescan: noopScheduler(),
    });

    expect(result).toEqual({ ok: true });
    expect(fsState.has('/music/Artist/Album/s1.mp3')).toBe(false);
    expect(sharedDb.query('SELECT id FROM library_songs WHERE id = ?').get('s1')).toBeNull();
  });

  it('fails when the music directory is not configured', async () => {
    seedSong('s2', 'alb', '/music/s2.mp3');
    const result = await deleteOne(sharedDb, 's2', {
      musicDir: undefined,
      shareRescan: noopScheduler(),
    });
    expect(result).toEqual({ ok: false, error: 'Music directory not configured', status: 500 });
  });

  it('fails with 404 when the song has no canonical row', async () => {
    const result = await deleteOne(sharedDb, 'missing', {
      musicDir: '/music',
      shareRescan: noopScheduler(),
    });
    expect(result).toEqual({ ok: false, error: 'Song not found in library', status: 404 });
  });

  it('cleans up the orphaned DB row when the file is already gone from disk', async () => {
    seedSong('s3', 'alb', '/music/gone.mp3');
    // No fsState entry — the file is already missing.
    const result = await deleteOne(sharedDb, 's3', {
      musicDir: '/music',
      shareRescan: noopScheduler(),
    });
    expect(result).toEqual({ ok: true });
    expect(sharedDb.query('SELECT id FROM library_songs WHERE id = ?').get('s3')).toBeNull();
  });
});

// Issue #774: `song_count` is the `owned` side of the completeness dimension and
// feeds album cards, so a stale high count makes a freshly-deduped album look
// complete. Prod, 2026-08-27: deadmau5 `while(1<2)` read 40 after 16 dupes were
// deleted (24 actually listed); Ana Tijoux `Kaos` read 24 against 14.
describe('deleteOne — album aggregates', () => {
  beforeEach(() => {
    fsState.clear();
    dirEntries.clear();
    sharedDb.run('DELETE FROM library_albums');
    sharedDb.run('DELETE FROM library_songs');
  });

  function seedAlbum(id: string, songCount: number, duration: number): void {
    sharedDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, cover_art, song_count, duration, synced_at)
       VALUES (?, 'Album', 'Artist', 'art', ?, ?, ?, 1)`,
      [id, id, songCount, duration],
    );
  }

  it('recomputes song_count and duration from the surviving songs', async () => {
    seedAlbum('alb-agg', 2, 400);
    seedSong('a1', 'alb-agg', '/music/Artist/Album/a1.mp3');
    seedSong('a2', 'alb-agg', '/music/Artist/Album/a2.mp3');
    sharedDb.run('UPDATE library_songs SET duration = 200 WHERE album_id = ?', ['alb-agg']);
    fsState.set('/music/Artist/Album/a1.mp3', true);

    await deleteOne(sharedDb, 'a1', { musicDir: '/music', shareRescan: noopScheduler() });

    const album = sharedDb
      .query<{ song_count: number; duration: number }, [string]>(
        'SELECT song_count, duration FROM library_albums WHERE id = ?',
      )
      .get('alb-agg');
    expect(album).toMatchObject({ song_count: 1, duration: 200 });
  });

  it('recomputes them on the already-gone-from-disk path too', async () => {
    seedAlbum('alb-ghost', 2, 400);
    seedSong('g1', 'alb-ghost', '/music/Artist/Album/g1.mp3');
    seedSong('g2', 'alb-ghost', '/music/Artist/Album/g2.mp3');
    // No fsState entry for g1 — the file is already missing.
    await deleteOne(sharedDb, 'g1', { musicDir: '/music', shareRescan: noopScheduler() });

    const album = sharedDb
      .query<{ song_count: number }, [string]>('SELECT song_count FROM library_albums WHERE id = ?')
      .get('alb-ghost');
    expect(album?.song_count).toBe(1);
  });

  it('drops an album that lost its last song rather than leaving an empty shell', async () => {
    seedAlbum('alb-last', 1, 200);
    seedSong('l1', 'alb-last', '/music/Artist/Album/l1.mp3');
    fsState.set('/music/Artist/Album/l1.mp3', true);

    await deleteOne(sharedDb, 'l1', { musicDir: '/music', shareRescan: noopScheduler() });

    expect(sharedDb.query('SELECT id FROM library_albums WHERE id = ?').get('alb-last')).toBeNull();
  });
});

// Issue #771: `library_genres.song_count` is a stored facet, not a live
// aggregate — `GET /api/library/genres` reads the column straight. Every
// MUTATION path already refreshes it through `setSongGenres`; the gap was
// deletion. Measured on prod 2026-08-27: Synth-Pop listed 283 against a facet
// of 305, Avant-Garde Jazz 35 against 37.
describe('deletion — genre facet counts', () => {
  beforeEach(() => {
    fsState.clear();
    dirEntries.clear();
    sharedDb.run('DELETE FROM library_albums');
    sharedDb.run('DELETE FROM library_songs');
    sharedDb.run('DELETE FROM library_song_genres');
    sharedDb.run('DELETE FROM library_genres');
  });

  function seedGenre(songId: string, genre: string): void {
    sharedDb.run('INSERT INTO library_song_genres (song_id, genre, position) VALUES (?, ?, 0)', [
      songId,
      genre,
    ]);
  }
  function facet(name: string): number | null {
    return (
      sharedDb
        .query<{ song_count: number }, [string]>(
          'SELECT song_count FROM library_genres WHERE name = ?',
        )
        .get(name)?.song_count ?? null
    );
  }

  it('decrements a genre that merely shrank on a single-song delete', async () => {
    sharedDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, cover_art, song_count, duration, synced_at)
       VALUES ('alb-g', 'Album', 'Artist', 'art', 'alb-g', 2, 400, 1)`,
    );
    seedSong('sg1', 'alb-g', '/music/Artist/Album/sg1.mp3');
    seedSong('sg2', 'alb-g', '/music/Artist/Album/sg2.mp3');
    seedGenre('sg1', 'Synth-Pop');
    seedGenre('sg2', 'Synth-Pop');
    sharedDb.run(
      `INSERT INTO library_genres (name, song_count, album_count, synced_at) VALUES ('Synth-Pop', 2, 1, 1)`,
    );
    fsState.set('/music/Artist/Album/sg1.mp3', true);

    await deleteOne(sharedDb, 'sg1', { musicDir: '/music', shareRescan: noopScheduler() });

    // Not 2. The orphaned library_song_genres row survives the delete (no FK
    // cascade, by design), so the count only moves because it JOINs.
    expect(facet('Synth-Pop')).toBe(1);
  });

  it('drops a genre whose last song went away', async () => {
    sharedDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, cover_art, song_count, duration, synced_at)
       VALUES ('alb-h', 'Album', 'Artist', 'art', 'alb-h', 1, 200, 1)`,
    );
    seedSong('sh1', 'alb-h', '/music/Artist/Album/sh1.mp3');
    seedGenre('sh1', 'Gabber');
    sharedDb.run(
      `INSERT INTO library_genres (name, song_count, album_count, synced_at) VALUES ('Gabber', 1, 1, 1)`,
    );
    fsState.set('/music/Artist/Album/sh1.mp3', true);

    await deleteOne(sharedDb, 'sh1', { musicDir: '/music', shareRescan: noopScheduler() });

    expect(facet('Gabber')).toBeNull();
  });

  it('deleting a whole album decrements every genre its songs carried', async () => {
    // The album's own `genre` mirror is ONE value; its songs between them can
    // carry many, and the old prune only ever looked at that one.
    sharedDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, cover_art, song_count, duration, genre, synced_at)
       VALUES ('alb-multi', 'Album', 'Artist', 'art', 'alb-multi', 2, 400, 'Techno', 1)`,
    );
    seedSong('m1', 'alb-multi', '/music/Artist/Album/m1.mp3');
    seedSong('m2', 'alb-multi', '/music/Artist/Album/m2.mp3');
    seedGenre('m1', 'Techno');
    seedGenre('m2', 'Acid House');
    // A survivor elsewhere keeps 'Acid House' alive, so it must shrink, not vanish.
    sharedDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, cover_art, song_count, duration, synced_at)
       VALUES ('alb-other', 'Other', 'Artist', 'art', 'alb-other', 1, 200, 1)`,
    );
    seedSong('o1', 'alb-other', '/music/Artist/Other/o1.mp3');
    seedGenre('o1', 'Acid House');
    sharedDb.run(
      `INSERT INTO library_genres (name, song_count, album_count, synced_at) VALUES ('Techno', 1, 1, 1), ('Acid House', 2, 2, 1)`,
    );
    fsState.set('/music/Artist/Album/m1.mp3', true);
    fsState.set('/music/Artist/Album/m2.mp3', true);

    await deleteAlbum(sharedDb, 'alb-multi', { musicDir: '/music', shareRescan: noopScheduler() });

    expect(facet('Techno')).toBeNull();
    expect(facet('Acid House')).toBe(1);
  });
});

describe('deleteAlbum', () => {
  beforeEach(() => {
    fsState.clear();
    dirEntries.clear();
    sharedDb.run(`DELETE FROM library_songs`);
    sharedDb.run(`DELETE FROM library_albums`);
    sharedDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, genre, synced_at) VALUES ('alb1', 'Album One', 'Artist', 'art', NULL, 1)`,
    );
  });

  it('returns null when the album has no rows at all', async () => {
    const result = await deleteAlbum(sharedDb, 'nonexistent', {
      musicDir: '/music',
      shareRescan: noopScheduler(),
    });
    expect(result).toBeNull();
  });

  it('deletes the album folder in one shot and clears the canonical rows', async () => {
    seedSong('t1', 'alb1', '/music/Artist/Album One/t1.mp3');
    seedSong('t2', 'alb1', '/music/Artist/Album One/t2.mp3');
    fsState.set('/music/Artist/Album One/t1.mp3', true);
    fsState.set('/music/Artist/Album One/t2.mp3', true);
    dirEntries.set('/music/Artist/Album One', [
      { name: 't1.mp3', isFile: true, isDirectory: false },
      { name: 't2.mp3', isFile: true, isDirectory: false },
    ]);

    const result = await deleteAlbum(sharedDb, 'alb1', {
      musicDir: '/music',
      shareRescan: noopScheduler(),
    });

    expect(result?.ok).toBe(true);
    expect(result?.deletedCount).toBe(2);
    expect(result?.albumRow).toEqual({ name: 'Album One', artist: 'Artist' });
    expect(sharedDb.query('SELECT id FROM library_albums WHERE id = ?').get('alb1')).toBeNull();
    expect(sharedDb.query('SELECT id FROM library_songs WHERE album_id = ?').all('alb1')).toEqual(
      [],
    );
  });
});
