import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * A fixture Lidarr, so the guided acquire surface runs end to end (#1547): catalog
 * cards, resolve, hunt, Get. It answers the endpoints `packages/api/src/lidarr/api/*`
 * calls, and it is a process of its own because the server reads NICOTIND_LIDARR_URL
 * once at boot.
 *
 * It answers empty until a spec seeds it, so a spec that never asks for a catalog sees
 * no albums, which is what it saw when this URL was a dead port.
 *
 * Shapes follow `packages/api/src/lidarr/types.ts`, not a recording of a real Lidarr.
 * That makes it as permissive as our own types: it proves the wiring, not Lidarr's
 * behaviour. See docs/e2e.md.
 */
export const FIXTURE_LIDARR_PORT = process.env.E2E_LIDARR_PORT ?? '8589';
export const FIXTURE_LIDARR_URL = `http://127.0.0.1:${FIXTURE_LIDARR_PORT}`;

export interface SeedAlbum {
  id: number;
  foreignAlbumId: string;
  title: string;
  year?: number;
  albumType?: string;
  tracks: string[];
  /**
   * Found by the global lookup but absent from the artist's own discography, which
   * is how a compilation behaves: the card resolves to `ALBUM_NOT_IN_LIDARR`.
   */
  lookupOnly?: boolean;
}

export interface SeedArtist {
  id: number;
  foreignArtistId: string;
  artistName: string;
  /** Already added to Lidarr. False: `POST /artist` has to add it first (the 202 path). */
  provisioned?: boolean;
  albums: SeedAlbum[];
}

/** Replace what the fixture Lidarr knows. Empty by default, and between specs. */
export async function seedFixtureLidarr(artists: SeedArtist[]): Promise<void> {
  const res = await fetch(`${FIXTURE_LIDARR_URL}/__fixture/seed`, {
    method: 'POST',
    body: JSON.stringify({ artists }),
  });
  if (!res.ok) throw new Error(`seeding the fixture Lidarr failed: ${res.status}`);
}

export const resetFixtureLidarr = (): Promise<void> => seedFixtureLidarr([]);

// The smallest valid JPEG: what a catalog card's <img> has to decode (#1536).
const COVER_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////' +
    '////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAA' +
    'AAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z',
  'base64',
);

interface State {
  artists: SeedArtist[];
  provisioned: Set<number>;
  rootFolders: { id: number; path: string; freeSpace: number }[];
}

function artistDto(state: State, a: SeedArtist) {
  return {
    // A lookup hit Lidarr has not added carries id 0, as the real one does.
    id: state.provisioned.has(a.id) ? a.id : 0,
    foreignArtistId: a.foreignArtistId,
    artistName: a.artistName,
    sortName: a.artistName,
    status: 'continuing',
    images: [],
    albumCount: a.albums.length,
    monitored: state.provisioned.has(a.id),
  };
}

function albumDto(state: State, artist: SeedArtist, album: SeedAlbum) {
  return {
    id: state.provisioned.has(artist.id) ? album.id : 0,
    foreignAlbumId: album.foreignAlbumId,
    title: album.title,
    releaseDate: album.year ? `${album.year}-01-01T00:00:00Z` : undefined,
    albumType: album.albumType ?? 'Album',
    secondaryTypes: [],
    monitored: state.provisioned.has(artist.id),
    statistics: {
      trackCount: 0,
      totalTrackCount: album.tracks.length,
      sizeOnDisk: 0,
      percentOfTracks: 0,
    },
    images: [{ coverType: 'cover', url: `/MediaCover/${album.id}/cover.jpg` }],
    artist: artistDto(state, artist),
    releases: [{ trackCount: album.tracks.length }],
  };
}

const matches = (term: string, ...fields: string[]) => {
  const words = term.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = fields.join(' ').toLowerCase();
  return words.length > 0 && words.every((w) => hay.includes(w));
};

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function handle(state: State, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', FIXTURE_LIDARR_URL);
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const json = (value: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  const allAlbums = () =>
    state.artists.flatMap((artist) => artist.albums.map((album) => ({ artist, album })));
  const id = (prefix: string) => Number(path.slice(prefix.length));

  if (path === '/__fixture/health') return json({ ok: true });
  if (path === '/__fixture/seed' && method === 'POST') {
    const { artists } = (await bodyOf(req)) as { artists: SeedArtist[] };
    state.artists = artists;
    state.provisioned = new Set(artists.filter((a) => a.provisioned).map((a) => a.id));
    return json({ ok: true });
  }

  if (path.startsWith('/MediaCover/')) {
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    res.end(COVER_JPEG);
    return;
  }

  if (path === '/api/v1/artist/lookup') {
    const term = url.searchParams.get('term') ?? '';
    return json(
      state.artists.filter((a) => matches(term, a.artistName)).map((a) => artistDto(state, a)),
    );
  }
  if (path === '/api/v1/album/lookup') {
    const term = url.searchParams.get('term') ?? '';
    return json(
      allAlbums()
        .filter(({ artist, album }) => matches(term, artist.artistName, album.title))
        .map(({ artist, album }) => albumDto(state, artist, album)),
    );
  }
  if (path === '/api/v1/artist' && method === 'GET') {
    return json(
      state.artists.filter((a) => state.provisioned.has(a.id)).map((a) => artistDto(state, a)),
    );
  }
  if (path === '/api/v1/artist' && method === 'POST') {
    const { foreignArtistId } = await bodyOf(req);
    const artist = state.artists.find((a) => a.foreignArtistId === foreignArtistId);
    if (!artist) return json({ message: 'unknown artist' }, 400);
    state.provisioned.add(artist.id);
    return json(artistDto(state, artist), 201);
  }
  if (path.startsWith('/api/v1/artist/')) {
    const artist = state.artists.find((a) => a.id === id('/api/v1/artist/'));
    return artist ? json(artistDto(state, artist)) : json({ message: 'not found' }, 404);
  }
  if (path === '/api/v1/album') {
    const artistId = Number(url.searchParams.get('artistId'));
    return json(
      allAlbums()
        .filter(({ artist, album }) => artist.id === artistId && !album.lookupOnly)
        .map(({ artist, album }) => albumDto(state, artist, album)),
    );
  }
  if (path.startsWith('/api/v1/album/')) {
    const hit = allAlbums().find(({ album }) => album.id === id('/api/v1/album/'));
    return hit ? json(albumDto(state, hit.artist, hit.album)) : json({ message: 'not found' }, 404);
  }
  if (path === '/api/v1/track') {
    const albumId = Number(url.searchParams.get('albumId'));
    const hit = allAlbums().find(({ album }) => album.id === albumId);
    return json(
      (hit?.album.tracks ?? []).map((title, i) => ({
        id: albumId * 100 + i,
        foreignTrackId: `track-${albumId}-${i}`,
        foreignRecordingId: `recording-${albumId}-${i}`,
        trackFileId: 0,
        albumId,
        artistId: hit!.artist.id,
        trackNumber: String(i + 1),
        absoluteTrackNumber: i + 1,
        title,
        duration: 30_000,
        hasFile: false,
      })),
    );
  }
  if (path === '/api/v1/qualityprofile' || path === '/api/v1/metadataprofile') {
    return json([{ id: 1, name: 'Any' }]);
  }
  if (path === '/api/v1/rootfolder' && method === 'GET') return json(state.rootFolders);
  if (path === '/api/v1/rootfolder' && method === 'POST') {
    const { path: folder } = await bodyOf(req);
    const added = { id: state.rootFolders.length + 1, path: String(folder), freeSpace: 0 };
    state.rootFolders.push(added);
    return json(added, 201);
  }
  if (path === '/api/v1/wanted/missing') return json({ records: [], totalRecords: 0 });
  return json({ message: `fixture Lidarr has no ${method} ${path}` }, 404);
}

export function startFixtureLidarr(port = Number(FIXTURE_LIDARR_PORT)) {
  const state: State = { artists: [], provisioned: new Set(), rootFolders: [] };
  const server = createServer((req, res) => {
    handle(state, req, res).catch((err: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: String(err) }));
    });
  });
  server.listen(port, '127.0.0.1');
  return server;
}

// Launched by playwright.config.ts as a `webServer` of its own.
if (import.meta.main) startFixtureLidarr();
