/**
 * A stand-in Lidarr that knows the demo catalog — every album, in both pools.
 *
 * why: the guided acquire path (catalog search → album card → hunt) is
 * Lidarr-gated (`CatalogService`, `/api/discography/albums/:id/hunt*`), and the
 * e2e environment has no Lidarr. This answers the dozen read endpoints that path
 * calls, so the tour drives the REAL search, resolve, hunt, download, organize
 * and scan instead of mocking any of it in the browser.
 *
 * Every artist is reported as already monitored, so resolve never takes the
 * add-artist (provisioning) detour. Sleeves are served under `/MediaCover/` —
 * the path shape Lidarr uses for its locally cached art, which the server's
 * cover proxy resolves against the configured Lidarr URL (`lidarrCoverPath`).
 */
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO_ALBUMS, demoTracks, hashSeed, type DemoAlbum } from '../../core/src/demo/index.js';
import { albumDir } from './make-demo-library.js';

/** A stable, MBID-shaped id from a seed — the catalog is invented, so is its MusicBrainz. */
function fakeMbid(seed: string): string {
  const hex = [0, 1, 2, 3]
    .map((i) => hashSeed(`${i}:${seed}`).toString(16).padStart(8, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const matchesAll = (text: string, term: string) => {
  const hay = fold(text);
  return fold(term)
    .split(/\s+/)
    .filter(Boolean)
    .every((tok) => hay.includes(tok));
};

interface ArtistRow {
  id: number;
  name: string;
  albums: AlbumRow[];
}
interface AlbumRow {
  id: number;
  album: DemoAlbum;
  artist: ArtistRow;
}

export function buildLidarrModel() {
  const artists = new Map<string, ArtistRow>();
  const albums: AlbumRow[] = [];
  for (const album of DEMO_ALBUMS) {
    let artist = artists.get(album.artist);
    if (!artist) {
      artist = { id: artists.size + 1, name: album.artist, albums: [] };
      artists.set(album.artist, artist);
    }
    const row: AlbumRow = { id: albums.length + 1, album, artist };
    artist.albums.push(row);
    albums.push(row);
  }
  return { artists: [...artists.values()], albums };
}

function artistJson(a: ArtistRow) {
  return {
    id: a.id,
    foreignArtistId: fakeMbid(`artist:${a.name}`),
    artistName: a.name,
    sortName: a.name,
    status: 'continuing',
    overview: `${a.name} is an invented act from the NicotinD demo catalog.`,
    genres: [...new Set(a.albums.map((r) => r.album.genre))],
    images: [{ coverType: 'poster', url: `/MediaCover/Artists/${a.id}/poster.jpg` }],
    albumCount: a.albums.length,
    monitored: true,
    qualityProfileId: 1,
    rootFolderPath: '/music',
    path: `/music/${a.name}`,
  };
}

function albumJson(r: AlbumRow) {
  const cover = `/MediaCover/Albums/${r.id}/cover.jpg`;
  return {
    id: r.id,
    foreignAlbumId: fakeMbid(`album:${r.album.artist}:${r.album.title}`),
    title: r.album.title,
    releaseDate: `${r.album.year}-03-14T00:00:00Z`,
    albumType: 'Album',
    secondaryTypes: [],
    genres: [r.album.genre],
    statistics: {
      trackCount: 0,
      totalTrackCount: r.album.tracks.length,
      sizeOnDisk: 0,
      percentOfTracks: 0,
    },
    monitored: true,
    images: [{ coverType: 'cover', url: cover, remoteUrl: cover }],
    artist: artistJson(r.artist),
  };
}

function trackJson(r: AlbumRow) {
  return demoTracks(r.album).map((t) => ({
    id: r.id * 100 + t.trackNumber,
    foreignTrackId: fakeMbid(`track:${t.seed}`),
    foreignRecordingId: fakeMbid(`recording:${t.seed}`),
    trackFileId: 0,
    albumId: r.id,
    artistId: r.artist.id,
    trackNumber: String(t.trackNumber),
    absoluteTrackNumber: t.trackNumber,
    title: t.title,
    duration: Math.round(t.tone.durationSec * 1000),
    hasFile: false,
  }));
}

export async function startDemoLidarr(port: number): Promise<Server> {
  const { artists, albums } = buildLidarrModel();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const jpeg = (file: string) => {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(readFileSync(file));
    };

    if (path === '/ping') return json(200, { status: 'OK' });

    const albumCover = path.match(/^\/MediaCover\/Albums\/(\d+)\/cover\.jpg$/);
    if (albumCover) {
      const row = albums.find((a) => a.id === Number(albumCover[1]));
      return row ? jpeg(join(albumDir(row.album), 'cover.jpg')) : json(404, {});
    }
    // An artist's portrait is the sleeve of their first album — the catalog has
    // no photos, and a sleeve reads as intended where a placeholder would not.
    const artistPoster = path.match(/^\/MediaCover\/Artists\/(\d+)\/poster\.jpg$/);
    if (artistPoster) {
      const row = artists.find((a) => a.id === Number(artistPoster[1]));
      return row ? jpeg(join(albumDir(row.albums[0]!.album), 'cover.jpg')) : json(404, {});
    }

    if (path === '/api/v1/artist' && req.method === 'GET')
      return json(200, artists.map(artistJson));
    if (path === '/api/v1/artist/lookup') {
      const term = url.searchParams.get('term') ?? '';
      return json(200, artists.filter((a) => matchesAll(a.name, term)).map(artistJson));
    }
    const artistById = path.match(/^\/api\/v1\/artist\/(\d+)$/);
    if (artistById) {
      const a = artists.find((x) => x.id === Number(artistById[1]));
      return a ? json(200, artistJson(a)) : json(404, {});
    }

    if (path === '/api/v1/album/lookup') {
      const term = url.searchParams.get('term') ?? '';
      const hits = albums.filter((r) => matchesAll(`${r.album.title} ${r.album.artist}`, term));
      return json(200, hits.map(albumJson));
    }
    if (path === '/api/v1/album') {
      const artistId = Number(url.searchParams.get('artistId'));
      return json(200, albums.filter((r) => r.artist.id === artistId).map(albumJson));
    }
    const albumById = path.match(/^\/api\/v1\/album\/(\d+)$/);
    if (albumById) {
      const r = albums.find((x) => x.id === Number(albumById[1]));
      return r ? json(200, albumJson(r)) : json(404, {});
    }
    if (path === '/api/v1/track') {
      const r = albums.find((x) => x.id === Number(url.searchParams.get('albumId')));
      return json(200, r ? trackJson(r) : []);
    }

    if (path === '/api/v1/qualityprofile') return json(200, [{ id: 1, name: 'Any' }]);
    if (path === '/api/v1/metadataprofile') return json(200, [{ id: 1, name: 'Standard' }]);
    if (path === '/api/v1/rootfolder') {
      return json(req.method === 'POST' ? 201 : 200, req.method === 'POST' ? { id: 1 } : []);
    }
    if (path === '/api/v1/wanted/missing') return json(200, { records: [] });

    return json(404, { error: `demo lidarr: no route for ${req.method} ${path}` });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}
