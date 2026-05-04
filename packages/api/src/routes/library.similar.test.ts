import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { libraryRoutes } from './library.js';

type SimilarSong = { id: string; artist: string; title: string };

function makeNavidromeMock(
  sourceSong: ReturnType<typeof buildSourceSong>,
  artistAlbums: ReturnType<typeof buildArtistAlbums>,
  album1Songs: SimilarSong[],
  album2Songs: SimilarSong[],
  genreSongs: SimilarSong[],
) {
  return {
    browsing: {
      getSong: mock(() => Promise.resolve(sourceSong)),
      getArtist: mock(() => Promise.resolve({ artist: { id: 'artist-1', name: 'Artist A', albumCount: 2 }, albums: artistAlbums })),
      getAlbum: mock((id: string) => {
        if (id === 'album-1') return Promise.resolve({ album: artistAlbums[0], songs: album1Songs });
        if (id === 'album-2') return Promise.resolve({ album: artistAlbums[1], songs: album2Songs });
        return Promise.resolve({ album: {}, songs: [] });
      }),
      getSongsByGenre: mock(() => Promise.resolve(genreSongs)),
    },
  };
}

function buildSourceSong() {
  return {
    id: 'song-src', title: 'Source', artist: 'Artist A', artistId: 'artist-1',
    album: 'Album X', albumId: 'album-1', genre: 'Jazz', year: 2010,
    path: '/music/Jazz/Artist A/Album X/song.flac', duration: 180,
    coverArt: 'cover-1', size: 1000, contentType: 'audio/flac', suffix: 'flac',
    bitRate: 320, created: '2024-01-01',
  };
}

function buildArtistAlbums() {
  return [
    { id: 'album-1', name: 'Album X', artist: 'Artist A', artistId: 'artist-1', songCount: 2, duration: 400, created: '2024-01-01' },
    { id: 'album-2', name: 'Album Y', artist: 'Artist A', artistId: 'artist-1', songCount: 2, duration: 350, created: '2023-01-01' },
  ];
}

describe('GET /songs/:id/similar', () => {
  let navidromeMock: ReturnType<typeof makeNavidromeMock>;
  let app: Hono;

  const sourceSong = buildSourceSong();
  const artistAlbums = buildArtistAlbums();

  const album1Songs = [
    { ...sourceSong, id: 'song-src' },
    { ...sourceSong, id: 'song-a2', title: 'Track 2', albumId: 'album-1' },
  ];
  const album2Songs = [
    { ...sourceSong, id: 'song-b1', title: 'B Track 1', albumId: 'album-2' },
  ];
  const genreSongs = [
    { ...sourceSong, id: 'song-g1', title: 'Genre Track', artist: 'Artist B', artistId: 'artist-2', year: 2012 },
  ];

  beforeEach(() => {
    navidromeMock = makeNavidromeMock(sourceSong, artistAlbums, album1Songs, album2Songs, genreSongs);

    app = new Hono();
    app.route('/', libraryRoutes(navidromeMock as unknown as Parameters<typeof libraryRoutes>[0], '/music'));
  });

  it('returns similar songs excluding the source song', async () => {
    const res = await app.request('/songs/song-src/similar?size=20');
    expect(res.status).toBe(200);
    const body = await res.json() as SimilarSong[];
    expect(body.find((s) => s.id === 'song-src')).toBeUndefined();
  });

  it('includes same-artist songs', async () => {
    const res = await app.request('/songs/song-src/similar?size=20');
    const body = await res.json() as SimilarSong[];
    expect(body.find((s) => s.id === 'song-b1')).toBeDefined();
  });

  it('includes same-album songs', async () => {
    const res = await app.request('/songs/song-src/similar?size=20');
    const body = await res.json() as SimilarSong[];
    expect(body.find((s) => s.id === 'song-a2')).toBeDefined();
  });

  it('includes genre songs', async () => {
    const res = await app.request('/songs/song-src/similar?size=20');
    const body = await res.json() as SimilarSong[];
    expect(body.find((s) => s.id === 'song-g1')).toBeDefined();
  });

  it('ranks same-artist songs above genre-only songs', async () => {
    const res = await app.request('/songs/song-src/similar?size=20');
    const body = await res.json() as SimilarSong[];
    const artistIdx = body.findIndex((s) => s.artist === 'Artist A');
    const genreIdx = body.findIndex((s) => s.id === 'song-g1');
    expect(artistIdx).toBeLessThan(genreIdx);
  });

  it('returns 404 for unknown song id', async () => {
    navidromeMock.browsing.getSong = mock(() => Promise.reject(new Error('Not Found')));
    const res = await app.request('/songs/nonexistent/similar');
    expect(res.status).toBe(404);
  });

  it('caps results at the requested size', async () => {
    const res = await app.request('/songs/song-src/similar?size=2');
    const body = await res.json() as SimilarSong[];
    expect(body.length).toBeLessThanOrEqual(2);
  });
});
