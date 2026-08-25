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

function seedSong(id: string, albumId: string, title: string, track: number | null = null): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, track, synced_at)
     VALUES (?, ?, ?, 'A', 'artist-1', 0, ?, ?, 0)`,
    [id, albumId, title, `${id}.opus`, track],
  );
}

const trackOf = (id: string): number | null =>
  db
    .query<{ track: number | null }, [string]>('SELECT track FROM library_songs WHERE id = ?')
    .get(id)?.track ?? null;

/** Lidarr stub with both the album lookup and a library tracklist. */
function fakeLidarrWithTracks(
  hits: Array<{ id?: number; title: string; artist?: { artistName: string } }>,
  tracksByAlbumId: Record<number, Array<{ trackNumber: string; title: string }>>,
): OptimizeLidarr {
  return {
    album: { lookup: async () => hits },
    track: { listByAlbum: async (id: number) => tracksByAlbumId[id] ?? [] },
  } as unknown as Lidarr;
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

describe('optimizeAlbum — track numbers (issue #694)', () => {
  const TAPP = { artistName: 'The Alan Parsons Project' };

  it('fills missing track numbers from the Lidarr tracklist', async () => {
    seedAlbum({ id: 'alb-1', name: 'Eye In The Sky', artist: TAPP.artistName });
    seedSong('s1', 'alb-1', 'Sirius');
    seedSong('s2', 'alb-1', 'Eye In The Sky');

    const lidarr = fakeLidarrWithTracks([{ id: 13343, title: 'Eye in the Sky', artist: TAPP }], {
      13343: [
        { trackNumber: '1', title: 'Sirius' },
        { trackNumber: '2', title: 'Eye in the Sky' },
      ],
    });

    const r = await optimizeAlbum(db, lidarr, 'alb-1', { apply: true });

    expect(r.tracksNumbered).toBe(2);
    expect(trackOf('s1')).toBe(1);
    expect(trackOf('s2')).toBe(2);
  });

  it('never overwrites a track number the file already carries', async () => {
    seedAlbum({ id: 'alb-1', name: 'Eye In The Sky', artist: TAPP.artistName });
    seedSong('s1', 'alb-1', 'Sirius', 7); // curator/tag value wins

    const lidarr = fakeLidarrWithTracks([{ id: 13343, title: 'Eye in the Sky', artist: TAPP }], {
      13343: [{ trackNumber: '1', title: 'Sirius' }],
    });

    await optimizeAlbum(db, lidarr, 'alb-1', { apply: true });

    expect(trackOf('s1')).toBe(7);
  });

  it('refuses to half-number an album when the tracklist barely matches', async () => {
    seedAlbum({ id: 'alb-1', name: 'Eye In The Sky', artist: TAPP.artistName });
    seedSong('s1', 'alb-1', 'Sirius');
    seedSong('s2', 'alb-1', 'Some Live Bootleg Take');
    seedSong('s3', 'alb-1', 'Another Unrelated Cut');

    // Only 1 of 3 local songs is in the canonical tracklist — this is not the
    // same release, so numbering one track would be worse than numbering none.
    const lidarr = fakeLidarrWithTracks([{ id: 13343, title: 'Eye in the Sky', artist: TAPP }], {
      13343: [{ trackNumber: '1', title: 'Sirius' }],
    });

    const r = await optimizeAlbum(db, lidarr, 'alb-1', { apply: true });

    expect(r.tracksNumbered).toBe(0);
    expect(trackOf('s1')).toBeNull();
  });

  it('degrades quietly when the matched release is not in Lidarr’s library', async () => {
    seedAlbum({ id: 'alb-1', name: 'Eye In The Sky', artist: TAPP.artistName });
    seedSong('s1', 'alb-1', 'Sirius');

    // An un-provisioned release group comes back from lookup with no `id`, so
    // there is no tracklist to fetch. Must not throw, must not renumber.
    const lidarr = fakeLidarrWithTracks([{ title: 'Eye in the Sky', artist: TAPP }], {});

    const r = await optimizeAlbum(db, lidarr, 'alb-1', { apply: true });

    expect(r.matched).toBe(true);
    expect(r.tracksNumbered).toBe(0);
    expect(trackOf('s1')).toBeNull();
  });

  it('reports without writing on a dry run', async () => {
    seedAlbum({ id: 'alb-1', name: 'Eye In The Sky', artist: TAPP.artistName });
    seedSong('s1', 'alb-1', 'Sirius');

    const lidarr = fakeLidarrWithTracks([{ id: 13343, title: 'Eye in the Sky', artist: TAPP }], {
      13343: [{ trackNumber: '1', title: 'Sirius' }],
    });

    const r = await optimizeAlbum(db, lidarr, 'alb-1', { apply: false });

    expect(r.tracksNumbered).toBe(1);
    expect(trackOf('s1')).toBeNull();
  });
});

describe('optimizeAlbum', () => {
  it('overwrites cover, year and release type on a confident match', async () => {
    seedAlbum({
      id: 'alb-1',
      name: 'Drukqs',
      artist: 'Aphex Twin',
      year: null as unknown as number,
    });
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
      tracksNumbered: 0, // this album has no songs seeded
      lookedUp: true,
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
    const lidarr = fakeLidarr([
      { title: 'Completely Different', artist: { artistName: 'Someone' } },
    ]);
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
    expect(r.candidates).toBe(1);
    expect(r.visited).toBe(1);
    expect(looked).toEqual(['Y B']);
  });

  it('bounds the pass with limit, in SQL rather than a JS slice', async () => {
    for (const id of ['a', 'b', 'c']) seedAlbum({ id, name: id, artist: 'X' });
    const looked: string[] = [];
    const lidarr = fakeLidarr([]);
    const r = await optimizeAllAlbums(db, lidarr, {
      apply: false,
      limit: 2,
      optimizeOne: async (id) => {
        looked.push(id);
        return {
          matched: false,
          coverUpdated: false,
          yearUpdated: false,
          releaseTypeUpdated: false,
          tracksNumbered: 0,
          lookedUp: true,
        };
      },
    });
    // candidates is what the query selected, so a JS slice would report 3 here.
    expect(r.candidates).toBe(2);
    expect(looked).toEqual(['a', 'b']);
    expect(r.stopped).toBe(true);
    expect(r.cursor).toBe('b');
  });

  it('resumes from afterId, covering the set exactly once', async () => {
    for (const id of ['a', 'b', 'c']) seedAlbum({ id, name: id, artist: 'X' });
    const seen: string[] = [];
    const step = (afterId: string | null) =>
      optimizeAllAlbums(db, fakeLidarr([]), {
        apply: false,
        limit: 2,
        afterId,
        optimizeOne: async (id) => {
          seen.push(id);
          return {
            matched: false,
            coverUpdated: false,
            yearUpdated: false,
            releaseTypeUpdated: false,
            tracksNumbered: 0,
            lookedUp: true,
          };
        },
      });

    const first = await step(null);
    const second = await step(first.cursor);
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(second.stopped).toBe(false);
  });

  it('stops when shouldStop flips, keeping the counters earned so far', async () => {
    for (const id of ['a', 'b', 'c']) seedAlbum({ id, name: id, artist: 'X' });
    let done = 0;
    const r = await optimizeAllAlbums(db, fakeLidarr([]), {
      apply: false,
      shouldStop: () => done >= 1,
      optimizeOne: async () => {
        done += 1;
        return {
          matched: true,
          coverUpdated: true,
          yearUpdated: false,
          releaseTypeUpdated: false,
          tracksNumbered: 0,
          lookedUp: true,
        };
      },
    });
    expect(r.visited).toBe(1);
    expect(r.matched).toBe(1);
    expect(r.coversUpdated).toBe(1);
    expect(r.stopped).toBe(true);
  });

  it('carries on past a throwing album instead of discarding the pass', async () => {
    for (const id of ['a', 'b']) seedAlbum({ id, name: id, artist: 'X' });
    const r = await optimizeAllAlbums(db, fakeLidarr([]), {
      apply: false,
      optimizeOne: async (id) => {
        if (id === 'a') throw new Error('disk on fire');
        return {
          matched: true,
          coverUpdated: true,
          yearUpdated: false,
          releaseTypeUpdated: false,
          tracksNumbered: 0,
          lookedUp: true,
        };
      },
    });
    expect(r.failed).toBe(1);
    expect(r.errorSample).toBe('disk on fire');
    // The album after the failure still counted — before #622 the throw
    // rejected the whole pass and every counter was lost.
    expect(r.visited).toBe(2);
    expect(r.matched).toBe(1);
    expect(r.coversUpdated).toBe(1);
  });

  it('counts albums actually looked up, not rows selected', async () => {
    // A junk grouping is selected by the scope query but skipped before any
    // Lidarr call, so `visited` and `lookedUp` must diverge.
    seedAlbum({ id: 'real', name: 'Real Album', artist: 'A Band' });
    seedAlbum({ id: 'junk', name: 'Singles', artist: 'Various Artists' });
    const looked: string[] = [];
    const lidarr = {
      album: {
        lookup: async (term: string) => {
          looked.push(term);
          return [];
        },
      },
    } as unknown as Lidarr;

    const r = await optimizeAllAlbums(db, lidarr, { apply: false });
    expect(r.candidates).toBe(2);
    expect(r.visited).toBe(2);
    expect(r.lookedUp).toBe(1);
    expect(looked).toEqual(['A Band Real Album']);
  });

  it('emits cumulative progress once per album', async () => {
    for (const id of ['a', 'b']) seedAlbum({ id, name: id, artist: 'X' });
    const ticks: Array<{ visited: number; total: number; label: string }> = [];
    const r = await optimizeAllAlbums(db, fakeLidarr([]), {
      apply: false,
      onProgress: (p) => ticks.push({ visited: p.visited, total: p.total, label: p.label }),
    });
    expect(ticks).toEqual([
      { visited: 1, total: 2, label: 'X — a' },
      { visited: 2, total: 2, label: 'X — b' },
    ]);
    expect(r.visited).toBe(2);
  });
});
