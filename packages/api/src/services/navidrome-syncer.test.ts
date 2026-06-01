import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { NavidromeSyncer } from './navidrome-syncer.js';
import type { Navidrome } from '@nicotind/navidrome-client';
import type { Album } from '@nicotind/core';

function makeAlbum(id: string): Album {
  return {
    id,
    name: `Album ${id}`,
    artist: 'Artist',
    artistId: 'art-1',
    songCount: 1,
    duration: 100,
    created: '2024-01-01',
  };
}

/** Minimal Navidrome stub that returns a fixed album list and no songs/artists/genres. */
function makeNavidrome(albums: Album[]): Navidrome {
  return {
    browsing: {
      getAlbumList: mock((_sort: string, _size: number, offset: number) =>
        Promise.resolve(offset === 0 ? albums : []),
      ),
      getArtists: mock(() => Promise.resolve([])),
      getGenres: mock(() => Promise.resolve([])),
      getAlbum: mock(() => Promise.resolve({ songs: [] })),
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
