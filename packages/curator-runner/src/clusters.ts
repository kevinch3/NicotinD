import { readJson, type McpLike } from './mcp-client.js';

/**
 * A cluster is one album: the unit one genre judgement covers. Not the artist —
 * a DJ mix or compilation filed under one artist carries other artists' tracks,
 * and the 2026-10 pass found worklist rows whose artist label named none of the
 * songs (#1391). An album's tracklist is the evidence that judgement rests on.
 */
export interface SongRow {
  id: string;
  title: string;
  artist: string;
  genre: string | null;
  /** Full ordered genre list; absent on a server older than #1516. */
  genres?: string[];
  suffix?: string | null;
  bitRateKbps?: number | null;
}

export interface ArtistContext {
  id: string;
  name: string;
  country: string | null;
  hasMbid: boolean;
  /** The artist's other albums, with their (position-0) genre. */
  albums: Array<{ id: string; name: string; year: number | null; genre: string | null }>;
}

export interface Cluster {
  albumId: string;
  albumName: string;
  albumArtist: string;
  year: number | null;
  songs: SongRow[];
  /** Songs a replace cannot lose information on — the only ones ever written. */
  candidateIds: string[];
  artist: ArtistContext | null;
}

/** Mirrors the server's `JUNK_GENRES` / `LOW_INFORMATION_GENRES` (genre-split.ts). */
const JUNK = new Set([
  'other',
  'genre',
  'default',
  'unknown',
  'misc',
  'miscellaneous',
  'none',
  'no genre',
  'undefined',
  '<desconocido>',
  'entertainment',
  'music',
]);
const CATCH_ALL = new Set(['electronic', 'dance']);
const key = (g: string) => g.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Whether replacing this genre set loses nothing: no genre, junk only, or one
 * real genre that is a catch-all. The server enforces the same rule on an auto
 * token's writes; the runner applies it too so a CARD — which a human taps and
 * no policy re-checks — never offers to overwrite a real genre.
 */
export function isReplaceable(genres: readonly string[]): boolean {
  const real = genres.filter((g) => !JUNK.has(key(g)));
  return real.length === 0 || (real.length === 1 && CATCH_ALL.has(key(real[0]!)));
}

/** A song's genre set, falling back to a lone position-0 value only when it is empty. */
function genreSet(song: SongRow): string[] | null {
  if (song.genres) return song.genres;
  // An old server shows position 0 only: safe to call "no genre", never "only Electronic".
  return song.genre ? null : [];
}

interface HealthGenres {
  dimensions: {
    genres: {
      lowInformationWorklist: Array<{ artistId: string; artist: string; songs: number }>;
    };
  };
}

interface ArtistResponse {
  id: string;
  name: string;
  origin: { country: string | null } | null;
  mbid: { id: string | null } | null;
  albums: Array<{ id: string; name: string; year: number | null; genre: string | null }>;
}

interface AlbumResponse {
  album: { id: string; name: string; artist: string; year: number | null } | null;
  songs: SongRow[];
}

/**
 * Album ids worth a look, in worklist order: every album of each artist on the
 * catch-all worklist, then the albums holding the most recently landed
 * genre-less songs.
 */
export async function collectAlbumIds(mcp: McpLike, sample = 50): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: string | null | undefined) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };
  const health = await readJson<HealthGenres>(mcp, 'get_library_health', {
    dimensions: ['genres'],
    sample,
  });
  for (const row of health.dimensions.genres.lowInformationWorklist) {
    const artist = await readJson<ArtistResponse>(mcp, 'get_artist', { id: row.artistId });
    for (const album of artist.albums) add(album.id);
  }
  const recent = await readJson<{ songs: Array<{ albumId: string | null }> }>(
    mcp,
    'list_recent_songs',
    { missingGenre: true, limit: 100 },
  );
  for (const song of recent.songs) add(song.albumId);
  return ids;
}

/** Load one album as a cluster, with its artist's context when it resolves. */
export async function loadCluster(
  mcp: McpLike,
  albumId: string,
  artistCache: Map<string, ArtistContext | null>,
): Promise<Cluster | null> {
  const res = await readJson<AlbumResponse>(mcp, 'get_album_tracks', { id: albumId });
  if (!res.album) return null;
  const candidateIds = res.songs
    .filter((s) => {
      const set = genreSet(s);
      return set != null && isReplaceable(set);
    })
    .map((s) => s.id);
  return {
    albumId,
    albumName: res.album.name,
    albumArtist: res.album.artist,
    year: res.album.year,
    songs: res.songs,
    candidateIds,
    artist: await artistContext(mcp, res.album.artist, artistCache),
  };
}

/** The album artist's library row, found by an exact (case-insensitive) name match. */
async function artistContext(
  mcp: McpLike,
  name: string,
  cache: Map<string, ArtistContext | null>,
): Promise<ArtistContext | null> {
  const k = key(name);
  if (cache.has(k)) return cache.get(k)!;
  const found = await readJson<{ artists: Array<{ id: string; name: string }> }>(
    mcp,
    'search_library',
    { query: name, limit: 10 },
  );
  const match = found.artists.find((a) => key(a.name) === k);
  let ctx: ArtistContext | null = null;
  if (match) {
    const a = await readJson<ArtistResponse>(mcp, 'get_artist', { id: match.id });
    ctx = {
      id: a.id,
      name: a.name,
      country: a.origin?.country ?? null,
      hasMbid: !!a.mbid?.id,
      albums: a.albums,
    };
  }
  cache.set(k, ctx);
  return ctx;
}
