/**
 * Tests for metadata optimization: overwriting cover/year/release-type from a
 * stubbed Lidarr against a real in-memory DB.
 */
import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Lidarr } from '@nicotind/lidarr-client';
import { applySchema } from '../db.js';
import { optimizeAlbum, optimizeAllAlbums, type OptimizeLidarr } from './metadata-optimize.js';
import { setArtwork } from './artwork-store.js';
import { getReleaseType } from './release-meta-store.js';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

function seedAlbum(a: { id: string; name: string; artist: string; year?: number }): void {
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, year, synced_at)
     VALUES (?, ?, ?, 'artist-1', 8, 0, ?, 0)`,
    [a.id, a.name, a.artist, a.year ?? null],
  );
}

/** Lidarr stub returning a fixed album.lookup payload. */
function fakeLidarr(
  hits: Array<{
    title: string;
    albumType?: string;
    releaseDate?: string;
    images?: Array<{ coverType: string; remoteUrl?: string; url: string }>;
    artist?: { artistName: string };
  }>,
): OptimizeLidarr {
  return { album: { lookup: async () => hits } } as unknown as Lidarr;
}

describe('optimizeAlbum', () => {
  it('overwrites cover, year and release type on a confident match', async () => {
    seedAlbum({ id: 'alb-1', name: 'Drukqs', artist: 'Aphex Twin', year: null as unknown as number });
    const lidarr = fakeLidarr([
      {
        title: 'Drukqs',
        albumType: 'Album',
        releaseDate: '2001-10-22',
        images: [{ coverType: 'cover', remoteUrl: 'https://img/drukqs.jpg', url: 'x' }],
        artist: { artistName: 'Aphex Twin' },
      },
    ]);

    const r = await optimizeAlbum(db, lidarr, 'alb-1', { apply: true });
    expect(r).toEqual({
      matched: true,
      coverUpdated: true,
      yearUpdated: true,
      releaseTypeUpdated: true,
    });

    const art = db
      .query<{ cover_url: string }, [string]>('SELECT cover_url FROM library_artwork WHERE id = ?')
      .get('alb-1');
    expect(art?.cover_url).toBe('https://img/drukqs.jpg');
    const year = db
      .query<{ year: number }, [string]>('SELECT year FROM library_albums WHERE id = ?')
      .get('alb-1');
    expect(year?.year).toBe(2001);
    expect(getReleaseType(db, 'alb-1')).toBe('album');
  });

  it('replaces an existing (wrong) cover — the fix-poor-thumbnail case', async () => {
    seedAlbum({ id: 'alb-1', name: 'Drukqs', artist: 'Aphex Twin', year: 2001 });
    setArtwork(db, 'alb-1', 'album', 'https://img/WRONG.jpg');
    const lidarr = fakeLidarr([
      {
        title: 'Drukqs',
        images: [{ coverType: 'cover', remoteUrl: 'https://img/right.jpg', url: 'x' }],
        artist: { artistName: 'Aphex Twin' },
      },
    ]);
    await optimizeAlbum(db, lidarr, 'alb-1', { apply: true });
    const art = db
      .query<{ cover_url: string }, [string]>('SELECT cover_url FROM library_artwork WHERE id = ?')
      .get('alb-1');
    expect(art?.cover_url).toBe('https://img/right.jpg');
  });

  it('dry run reports but does not write', async () => {
    seedAlbum({ id: 'alb-1', name: 'Drukqs', artist: 'Aphex Twin' });
    const lidarr = fakeLidarr([
      { title: 'Drukqs', images: [{ coverType: 'cover', url: 'https://img/d.jpg' }] },
    ]);
    const r = await optimizeAlbum(db, lidarr, 'alb-1', { apply: false });
    expect(r.matched).toBe(true);
    expect(r.coverUpdated).toBe(true);
    expect(db.query('SELECT id FROM library_artwork').get()).toBeNull();
  });

  it('returns unmatched when no Lidarr release-group matches', async () => {
    seedAlbum({ id: 'alb-1', name: 'Drukqs', artist: 'Aphex Twin' });
    const lidarr = fakeLidarr([{ title: 'Completely Different', artist: { artistName: 'Someone' } }]);
    const r = await optimizeAlbum(db, lidarr, 'alb-1', { apply: true });
    expect(r.matched).toBe(false);
  });

  it('skips junk groupings (Singles / Various Artists)', async () => {
    seedAlbum({ id: 'alb-1', name: 'Singles', artist: 'Various Artists' });
    let called = false;
    const lidarr = {
      album: {
        lookup: async () => {
          called = true;
          return [];
        },
      },
    } as unknown as Lidarr;
    const r = await optimizeAlbum(db, lidarr, 'alb-1', { apply: true });
    expect(r.matched).toBe(false);
    expect(called).toBe(false);
  });
});

describe('optimizeAllAlbums', () => {
  it('targets only albums missing artwork or year by default', async () => {
    seedAlbum({ id: 'has-art', name: 'A', artist: 'X', year: 2000 });
    setArtwork(db, 'has-art', 'album', 'https://img/a.jpg');
    seedAlbum({ id: 'no-art', name: 'B', artist: 'Y', year: 2001 });

    const looked: string[] = [];
    const lidarr = {
      album: {
        lookup: async (term: string) => {
          looked.push(term);
          return [];
        },
      },
    } as unknown as Lidarr;

    const r = await optimizeAllAlbums(db, lidarr, { apply: true });
    // Only the album without artwork is a candidate.
    expect(r.albums).toBe(1);
    expect(looked).toEqual(['Y B']);
  });
});
