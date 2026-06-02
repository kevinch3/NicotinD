import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { NavidromeSyncer } from './navidrome-syncer.js';
import type { Navidrome } from '@nicotind/navidrome-client';
import type { Album, Song } from '@nicotind/core';

function makeAlbum(id: string, overrides: Partial<Album> = {}): Album {
  return {
    id,
    name: `Album ${id}`,
    artist: 'Artist',
    artistId: 'art-1',
    songCount: 1,
    duration: 100,
    created: '2024-01-01',
    ...overrides,
  };
}

function makeSong(id: string, albumId: string, overrides: Partial<Song> = {}): Song {
  return {
    id,
    albumId,
    title: `Song ${id}`,
    artist: 'Artist',
    artistId: 'art-1',
    duration: 100,
    path: `/music/${id}.mp3`,
    size: 1000,
    bitRate: 320,
    suffix: 'mp3',
    contentType: 'audio/mpeg',
    created: '2024-01-01',
    ...overrides,
  } as Song;
}

/** Minimal Navidrome stub that returns a fixed album list and no songs/artists/genres. */
function makeNavidrome(albums: Album[], songsByAlbum: Record<string, Song[]> = {}): Navidrome {
  return {
    browsing: {
      getAlbumList: mock((_sort: string, _size: number, offset: number) =>
        Promise.resolve(offset === 0 ? albums : []),
      ),
      getArtists: mock(() => Promise.resolve([])),
      getGenres: mock(() => Promise.resolve([])),
      getAlbum: mock((id: string) => Promise.resolve({ songs: songsByAlbum[id] ?? [] })),
    },
  } as unknown as Navidrome;
}

describe('NavidromeSyncer tombstones', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  it('does not re-add a tombstoned album that Navidrome still reports', async () => {
    db.run(
      `INSERT INTO library_album_tombstones (album_id, name, created_at) VALUES ('alb-x', 'X', 1)`,
    );
    const syncer = new NavidromeSyncer(makeNavidrome([makeAlbum('alb-x'), makeAlbum('alb-y')]), db);

    await syncer.syncFull();

    expect(db.query(`SELECT id FROM library_albums WHERE id = 'alb-x'`).get()).toBeNull();
    expect(db.query(`SELECT id FROM library_albums WHERE id = 'alb-y'`).get()).not.toBeNull();
    // Still reported by Navidrome (scan not caught up) → tombstone survives.
    expect(db.query(`SELECT album_id FROM library_album_tombstones WHERE album_id = 'alb-x'`).get()).not.toBeNull();
  });

  it('clears the tombstone once Navidrome stops reporting the album', async () => {
    db.run(
      `INSERT INTO library_album_tombstones (album_id, name, created_at) VALUES ('alb-z', 'Z', 1)`,
    );
    const syncer = new NavidromeSyncer(makeNavidrome([]), db);

    await syncer.syncFull();

    expect(db.query(`SELECT album_id FROM library_album_tombstones WHERE album_id = 'alb-z'`).get()).toBeNull();
  });
});

describe('NavidromeSyncer album canonicalization', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  it('collapses mixed-MBID fragments of one folder into a single album row', async () => {
    // Three Navidrome "albums" for one <Artist>/<Album> folder, split by MBID.
    const frags = [
      makeAlbum('frag-a', { name: 'Are You Gonna Go My Way', artist: 'Lenny Kravitz', songCount: 6 }),
      makeAlbum('frag-b', { name: 'Are You Gonna Go My Way', artist: 'Lenny Kravitz', songCount: 3 }),
      makeAlbum('frag-c', { name: 'Are You Gonna Go My Way', artist: 'Lenny Kravitz', songCount: 12 }),
    ];
    const songs = {
      'frag-a': [makeSong('s1', 'frag-a'), makeSong('s2', 'frag-a')],
      'frag-b': [makeSong('s3', 'frag-b')],
      'frag-c': [makeSong('s4', 'frag-c'), makeSong('s5', 'frag-c')],
    };
    await new NavidromeSyncer(makeNavidrome(frags, songs), db).syncFull();

    const albums = db.query<{ id: string; song_count: number }, []>('SELECT id, song_count FROM library_albums').all();
    expect(albums).toHaveLength(1);
    // Canonical id is the fullest fragment (frag-c, 12 songs).
    expect(albums[0]!.id).toBe('frag-c');
    // song_count reflects the remapped songs actually synced (2+1+2), not the
    // sum of the fragments' inflated counts.
    expect(albums[0]!.song_count).toBe(5);

    const songRows = db.query<{ album_id: string }, []>('SELECT album_id FROM library_songs').all();
    expect(songRows).toHaveLength(5);
    expect(songRows.every((s) => s.album_id === 'frag-c')).toBe(true);
  });

  it('merges punctuation-variant sibling folders (¡Bang! …/...) into one album', async () => {
    const frags = [
      makeAlbum('bang-1', { name: '¡Bang! ¡Bang! Estás liquidado', artist: 'Patricio Rey', songCount: 17 }),
      makeAlbum('bang-2', { name: '¡Bang! ¡Bang!... Estás liquidado', artist: 'Patricio Rey', songCount: 9 }),
      makeAlbum('bang-3', { name: '¡Bang! ¡Bang! … Estás liquidado', artist: 'Patricio Rey', songCount: 1 }),
    ];
    await new NavidromeSyncer(makeNavidrome(frags), db).syncFull();

    const albums = db.query<{ id: string }, []>('SELECT id FROM library_albums').all();
    expect(albums).toHaveLength(1);
    expect(albums[0]!.id).toBe('bang-1'); // fullest fragment
  });

  it('leaves genuinely distinct albums (and deluxe editions) untouched', async () => {
    const albums = [
      makeAlbum('a', { name: 'Are You Gonna Go My Way', artist: 'Lenny Kravitz' }),
      makeAlbum('b', { name: 'Are You Gonna Go My Way (20th Anniversary Deluxe Edition)', artist: 'Lenny Kravitz' }),
      makeAlbum('c', { name: 'Mama Said', artist: 'Lenny Kravitz' }),
    ];
    await new NavidromeSyncer(makeNavidrome(albums), db).syncFull();
    expect(db.query('SELECT id FROM library_albums').all()).toHaveLength(3);
  });

  it('does not resurrect a deleted merged album via a surviving sibling fragment', async () => {
    // User deleted the album; we tombstoned the canonical id + artist. Navidrome's
    // scan has not caught up, so it still reports a sibling fragment under a
    // different id — the group-key suppression must keep the whole album gone.
    db.run(
      `INSERT INTO library_album_tombstones (album_id, name, artist, created_at)
       VALUES ('frag-c', 'Are You Gonna Go My Way', 'Lenny Kravitz', 1)`,
    );
    const frags = [
      makeAlbum('frag-a', { name: 'Are You Gonna Go My Way', artist: 'Lenny Kravitz', songCount: 6 }),
      makeAlbum('other', { name: 'Mama Said', artist: 'Lenny Kravitz' }),
    ];
    await new NavidromeSyncer(makeNavidrome(frags), db).syncFull();

    const names = db.query<{ name: string }, []>('SELECT name FROM library_albums').all().map((r) => r.name);
    expect(names).toEqual(['Mama Said']);
    // Tombstone survives because a fragment of the group is still reported.
    expect(
      db.query(`SELECT album_id FROM library_album_tombstones WHERE album_id = 'frag-c'`).get(),
    ).not.toBeNull();
  });
});
