import { describe, expect, it } from 'bun:test';
import type { GenreQuery, GenreResult } from '@nicotind/core';

import { albumGroupKey } from './album-grouping.js';
import { planDiscogsAlbumGenres, type DiscogsGenreAlbum } from './genre-discogs.js';

const album = (
  p: Partial<DiscogsGenreAlbum> & Pick<DiscogsGenreAlbum, 'albumName'>,
): DiscogsGenreAlbum => ({
  albumId: 'a1',
  albumArtist: 'Los Tetas',
  mbid: null,
  songs: [{ id: 's1', size: 100 }],
  ...p,
});

describe('planDiscogsAlbumGenres', () => {
  it('proposes an album override from a confident Discogs match', async () => {
    const resolve = async (): Promise<GenreResult> => ({
      genres: ['Funk', 'Soul'],
      source: 'discogs',
      confidence: 0.95,
    });
    const plan = await planDiscogsAlbumGenres([album({ albumName: 'Mama Funk' })], resolve);

    expect(plan.proposals).toHaveLength(1);
    const p = plan.proposals[0]!;
    expect(p.scope).toBe('album');
    expect(p.key).toBe(albumGroupKey('Los Tetas', 'Mama Funk'));
    expect(p.genres).toEqual(['Funk', 'Soul']);
    expect(p.source).toBe('discogs');
    expect(p.confidence).toBe(0.95);
  });

  it('auto-applies a high-confidence match and leaves a low-confidence one pending', async () => {
    const high = async (): Promise<GenreResult> => ({
      genres: ['Rock'],
      source: 'discogs',
      confidence: 0.9,
    });
    const low = async (): Promise<GenreResult> => ({
      genres: ['Rock'],
      source: 'discogs',
      confidence: 0.6,
    });
    const a = await planDiscogsAlbumGenres([album({ albumName: 'A' })], high);
    const b = await planDiscogsAlbumGenres([album({ albumName: 'B' })], low);
    expect(a.proposals[0]!.status).toBe('applied');
    expect(b.proposals[0]!.status).toBe('pending');
  });

  it('passes the release MBID through to the query when known', async () => {
    let seen: GenreQuery | null = null;
    const resolve = async (q: GenreQuery): Promise<GenreResult> => {
      seen = q;
      return { genres: ['Latin'], source: 'discogs', confidence: 0.9 };
    };
    await planDiscogsAlbumGenres([album({ albumName: 'X', mbid: 'rg-123' })], resolve);
    expect(seen!.mbid).toEqual({ releaseGroup: 'rg-123' });
    expect(seen!.artist).toBe('Los Tetas');
    expect(seen!.album).toBe('X');
  });

  it('makes no proposal on a confident miss but still reports the songs as processed', async () => {
    const resolve = async (): Promise<GenreResult | null> => null;
    const plan = await planDiscogsAlbumGenres(
      [
        album({
          albumName: 'Unknown',
          songs: [
            { id: 's1', size: 1 },
            { id: 's2', size: 2 },
          ],
        }),
      ],
      resolve,
    );
    expect(plan.proposals).toHaveLength(0);
    expect(plan.processedSongs.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('makes no proposal when the source returns an empty genre set', async () => {
    const resolve = async (): Promise<GenreResult> => ({
      genres: [],
      source: 'discogs',
      confidence: 0.9,
    });
    const plan = await planDiscogsAlbumGenres([album({ albumName: 'Empty' })], resolve);
    expect(plan.proposals).toHaveLength(0);
    expect(plan.processedSongs).toHaveLength(1);
  });

  it("does NOT report an album's songs as processed when the lookup throws (retry later, never ledger an outage)", async () => {
    const resolve = async (): Promise<GenreResult> => {
      throw new Error('Discogs 503');
    };
    const plan = await planDiscogsAlbumGenres([album({ albumName: 'Down' })], resolve);
    expect(plan.proposals).toHaveLength(0);
    expect(plan.processedSongs).toHaveLength(0);
    expect(plan.erroredAlbums).toBe(1);
  });

  it('reports every processed song across all albums (for the ledger)', async () => {
    const resolve = async (): Promise<GenreResult> => ({
      genres: ['Pop'],
      source: 'discogs',
      confidence: 0.9,
    });
    const plan = await planDiscogsAlbumGenres(
      [
        album({ albumName: 'One', albumId: 'a1', songs: [{ id: 's1', size: 1 }] }),
        album({
          albumName: 'Two',
          albumId: 'a2',
          songs: [
            { id: 's2', size: 2 },
            { id: 's3', size: 3 },
          ],
        }),
      ],
      resolve,
    );
    expect(plan.processedSongs.map((s) => s.id).sort()).toEqual(['s1', 's2', 's3']);
  });
});
