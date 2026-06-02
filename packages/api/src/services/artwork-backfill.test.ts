import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LidarrAlbum, LidarrArtist } from '@nicotind/lidarr-client';
import { applySchema } from '../db.js';
import { backfillArtwork, type BackfillLidarr } from './artwork-backfill.js';
import { resolveArtwork } from './artwork-store.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

function seedArtist(id: string, name: string): void {
  db.run('INSERT INTO library_artists (id, name, synced_at) VALUES (?, ?, 1)', [id, name]);
}
function seedAlbum(id: string, name: string, artistId: string, artist: string): void {
  db.run(
    'INSERT INTO library_albums (id, name, artist, artist_id, synced_at) VALUES (?, ?, ?, ?, 1)',
    [id, name, artist, artistId],
  );
}

interface MockData {
  list?: LidarrArtist[];
  lookup?: LidarrArtist[];
  albumsByArtist?: Record<number, LidarrAlbum[]>;
}

function makeLidarrMock(data: MockData): BackfillLidarr {
  return {
    artist: {
      list: async () => data.list ?? [],
      lookup: async () => data.lookup ?? [],
    },
    album: {
      listByArtist: async (id: number) => data.albumsByArtist?.[id] ?? [],
    },
  } as unknown as BackfillLidarr;
}

const artistImg = (url: string): LidarrImageLike[] => [{ coverType: 'poster', url }];
const albumImg = (url: string): LidarrImageLike[] => [{ coverType: 'cover', url }];
type LidarrImageLike = { coverType: string; url: string; remoteUrl?: string };

describe('backfillArtwork', () => {
  it('matches a monitored artist by name and writes artist + album artwork', async () => {
    seedArtist('art-1', 'Radiohead');
    seedAlbum('alb-1', 'OK Computer', 'art-1', 'Radiohead');
    const lidarr = makeLidarrMock({
      list: [
        { id: 7, artistName: 'Radiohead', images: artistImg('https://x/poster.jpg') } as LidarrArtist,
      ],
      albumsByArtist: {
        7: [{ title: 'OK Computer', images: albumImg('https://x/ok.jpg') } as LidarrAlbum],
      },
    });

    const r = await backfillArtwork(db, lidarr, { apply: true });
    expect(r.artistsMatched).toBe(1);
    expect(r.albumsMatched).toBe(1);
    expect(resolveArtwork(db, 'art-1')?.url).toBe('https://x/poster.jpg');
    expect(resolveArtwork(db, 'alb-1')?.url).toBe('https://x/ok.jpg');
  });

  it('does not write anything on a dry run', async () => {
    seedArtist('art-1', 'Radiohead');
    const lidarr = makeLidarrMock({
      list: [{ id: 7, artistName: 'Radiohead', images: artistImg('https://x/p.jpg') } as LidarrArtist],
    });
    const r = await backfillArtwork(db, lidarr, { apply: false });
    expect(r.artistsMatched).toBe(1);
    expect(resolveArtwork(db, 'art-1')).toBeNull();
  });

  it('resolves an artist via its discography link id', async () => {
    seedArtist('art-1', 'Stored As Different Name');
    db.run(
      'INSERT INTO artist_discography_links (artist_id, lidarr_id, mbid, checked_at) VALUES (?, ?, ?, 1)',
      ['art-1', 7, 'mbid'],
    );
    const lidarr = makeLidarrMock({
      list: [{ id: 7, artistName: 'Real Name', images: artistImg('https://x/p.jpg') } as LidarrArtist],
    });
    const r = await backfillArtwork(db, lidarr, { apply: true });
    expect(r.artistsMatched).toBe(1);
    expect(resolveArtwork(db, 'art-1')?.url).toBe('https://x/p.jpg');
  });

  it('matches albums by edition-stripped group key', async () => {
    seedArtist('art-1', 'Britney Spears');
    seedAlbum('alb-1', 'Circus', 'art-1', 'Britney Spears');
    const lidarr = makeLidarrMock({
      list: [{ id: 7, artistName: 'Britney Spears', images: artistImg('https://x/p.jpg') } as LidarrArtist],
      albumsByArtist: {
        7: [{ title: 'Circus (Deluxe Edition)', images: albumImg('https://x/circus.jpg') } as LidarrAlbum],
      },
    });
    const r = await backfillArtwork(db, lidarr, { apply: true });
    expect(r.albumsMatched).toBe(1);
    expect(resolveArtwork(db, 'alb-1')?.url).toBe('https://x/circus.jpg');
  });

  it('counts an unresolved artist when Lidarr has no match', async () => {
    seedArtist('art-1', 'Totally Unknown');
    const lidarr = makeLidarrMock({ list: [], lookup: [] });
    const r = await backfillArtwork(db, lidarr, { apply: true });
    expect(r.artistsUnresolved).toBe(1);
    expect(r.artistsMatched).toBe(0);
  });

  it('falls back to a read-only lookup for non-monitored artists', async () => {
    seedArtist('art-1', 'Aphex Twin');
    const lidarr = makeLidarrMock({
      list: [],
      lookup: [{ id: 0, artistName: 'Aphex Twin', images: artistImg('https://x/aphex.jpg') } as LidarrArtist],
    });
    const r = await backfillArtwork(db, lidarr, { apply: true });
    expect(r.artistsMatched).toBe(1);
    expect(resolveArtwork(db, 'art-1')?.url).toBe('https://x/aphex.jpg');
  });
});
