import { Hono, type Context } from 'hono';
import type { Database } from 'bun:sqlite';
import {
  createLogger,
  parseLrc,
  type Artist,
  type LyricsDto,
  type SearchProviderResult,
  type Song,
} from '@nicotind/core';
import {
  pickFormat,
  renderSubsonic,
  renderSubsonicError,
  SubsonicError,
  type SubsonicFormat,
  type SubsonicPayload,
} from '../services/opensubsonic-response.js';
import {
  artistIndex,
  IGNORED_ARTICLES,
  toAlbumID3,
  toArtistID3,
  toChild,
  type LibraryAlbum,
  type StarLookup,
} from '../services/opensubsonic-map.js';
import type { SubsonicUser, Upstream } from '../services/opensubsonic-upstream.js';
import { verifySubsonicKey } from '../services/subsonic-keys.js';
import { PlaylistService } from '../services/playlist.service.js';
import { starItem, starredItems, unstarItem } from '../services/user-stars.js';

const log = createLogger('opensubsonic');

/**
 * OpenSubsonic API at `/rest/*` (docs/opensubsonic.md) — lets Music Assistant and
 * any Subsonic client use NicotinD as a music server.
 *
 * Every method translates onto NicotinD's own `/api` through `Upstream`, run as
 * the key's owner. Nothing here queries the library tables directly; the only
 * tables this layer owns are its API keys and the album/artist stars.
 */
export interface OpenSubsonicDeps {
  getDb: () => Database;
  serverVersion: string;
  upstream: Upstream;
  /** The local library search (LibrarySearchProvider) — never the network lane. */
  searchLibrary: (q: string) => Promise<SearchProviderResult | null>;
}

class SubsonicFail extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

class Params {
  constructor(private readonly q: Record<string, string[]>) {}
  get(name: string): string | undefined {
    return this.q[name]?.[0];
  }
  all(name: string): string[] {
    return this.q[name] ?? [];
  }
  require(name: string): string {
    const v = this.get(name);
    if (v === undefined || v === '') {
      throw new SubsonicFail(
        SubsonicError.MissingParameter,
        `Required parameter is missing: ${name}`,
      );
    }
    return v;
  }
  /** A non-negative int, clamped to `max`; malformed input falls back. */
  int(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
    const n = Number(this.get(name));
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.min(Math.trunc(n), max);
  }
}

async function readParams(c: Context): Promise<Params> {
  const q: Record<string, string[]> = { ...c.req.queries() };
  // The `formPost` extension: the same parameters as a form body, so a long
  // password or id list stays out of URLs and access logs.
  if (
    c.req.method === 'POST' &&
    (c.req.header('content-type') ?? '').includes('application/x-www-form-urlencoded')
  ) {
    for (const [k, v] of new URLSearchParams(await c.req.text())) (q[k] ??= []).push(v);
  }
  return new Params(q);
}

/** `p=enc:<hex>` is Subsonic's hex-obfuscated password form. */
function decodePassword(p: string): string {
  if (!p.startsWith('enc:')) return p;
  return Buffer.from(p.slice(4), 'hex').toString('utf8');
}

function authenticate(db: Database, p: Params): SubsonicUser {
  const apiKey = p.get('apiKey');
  const username = p.get('u');
  if (apiKey !== undefined) {
    if (username !== undefined) {
      throw new SubsonicFail(SubsonicError.ConflictingAuth, 'Provide either apiKey or u, not both');
    }
    const owner = verifySubsonicKey(db, apiKey);
    if (!owner) throw new SubsonicFail(SubsonicError.InvalidApiKey, 'Invalid API key');
    return { id: owner.userId, username: owner.username, role: owner.role };
  }
  if (username === undefined) {
    throw new SubsonicFail(SubsonicError.MissingParameter, 'Required parameter is missing: apiKey');
  }
  const password = p.get('p');
  if (password === undefined) {
    // Token auth is md5(password + salt): it needs a stored plaintext secret,
    // and NicotinD stores only hashes. An API key as `p` works instead.
    throw new SubsonicFail(
      SubsonicError.TokenAuthUnsupported,
      'Token authentication is not supported; use an API key',
    );
  }
  // Legacy `u=&p=`: the password is an API key, and must belong to `u`.
  const owner = verifySubsonicKey(db, decodePassword(password));
  if (!owner || owner.username.toLowerCase() !== username.toLowerCase()) {
    throw new SubsonicFail(SubsonicError.WrongCredentials, 'Wrong username or password');
  }
  return { id: owner.userId, username: owner.username, role: owner.role };
}

interface Call {
  p: Params;
  user: SubsonicUser;
  db: Database;
  req: Request;
  api: Api;
  stars: () => StarLookup;
}

type Handler = (call: Call) => Promise<SubsonicPayload | Response>;

interface Api {
  raw(path: string, init?: RequestInit): Promise<Response>;
  json<T>(path: string, init?: RequestInit): Promise<T>;
  send<T>(method: string, path: string, body?: unknown): Promise<T>;
}

function makeApi(upstream: Upstream, user: SubsonicUser): Api {
  const raw = (path: string, init?: RequestInit) => upstream(user, path, init);
  const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await raw(path, init);
    if (res.status === 404)
      throw new SubsonicFail(SubsonicError.NotFound, 'Requested data was not found');
    if (res.status === 401 || res.status === 403) {
      throw new SubsonicFail(
        SubsonicError.NotAuthorized,
        'User is not authorized for the given operation',
      );
    }
    if (!res.ok) throw new SubsonicFail(SubsonicError.Generic, `Upstream error ${res.status}`);
    return (await res.json()) as T;
  };
  return {
    raw,
    json,
    send: <T>(method: string, path: string, body?: unknown) =>
      json<T>(path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
  };
}

function loadStars(db: Database, userId: string): StarLookup {
  const iso = (m: Map<string, number>) =>
    new Map([...m].map(([id, t]) => [id, new Date(t).toISOString()]));
  return {
    songs: iso(new PlaylistService(db).likedSongDates(userId)),
    albums: iso(starredItems(db, userId, 'album')),
    artists: iso(starredItems(db, userId, 'artist')),
  };
}

const enc = encodeURIComponent;
const MAX_LIST = 500;
const ARTISTS_ALL = '/api/library/artists?size=5000';

type ArtistDetail = {
  artist: Artist & { bio?: string | null };
  albums: LibraryAlbum[];
  singlesAndEps: LibraryAlbum[];
};
type AlbumDetail = LibraryAlbum & { song: Song[] };
type PlaylistSummary = {
  id: string;
  name: string;
  description: string | null;
  songCount: number;
  kind: string;
  createdAt: number;
  modifiedAt: number;
};
type PlaylistDetail = PlaylistSummary & { songs: Song[] };

/** Run `fn` over `items` at most `limit` at a time, keeping order. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function resolveSongs(api: Api, ids: string[]): Promise<Song[]> {
  if (ids.length === 0) return [];
  return api.send<Song[]>('POST', '/api/library/songs/resolve', { ids });
}

/** Fetch albums by id, dropping any that vanished since they were referenced. */
async function albumsById(api: Api, ids: string[]): Promise<LibraryAlbum[]> {
  const albums = await mapLimited(ids, 8, (id) =>
    api.json<AlbumDetail>(`/api/library/albums/${enc(id)}`).catch(() => null),
  );
  return albums.filter((a): a is AlbumDetail => a !== null);
}

function playlistEntry(pl: PlaylistSummary, owner: string, duration = 0) {
  return {
    id: pl.id,
    name: pl.name,
    comment: pl.description ?? undefined,
    owner,
    public: pl.kind === 'curated',
    songCount: pl.songCount,
    duration,
    created: new Date(pl.createdAt).toISOString(),
    changed: new Date(pl.modifiedAt).toISOString(),
    // The playlist's own art is an SVG path, not a cover id; leave it unset
    // and clients fall back to a mosaic of the entries.
    readonly: pl.kind !== 'user',
  };
}

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

/** Which kind of library item an id names — a Subsonic id carries no type. */
function itemKind(db: Database, id: string): 'song' | 'album' | 'artist' | null {
  if (db.query('SELECT 1 FROM library_songs WHERE id = ?').get(id)) return 'song';
  if (db.query('SELECT 1 FROM library_albums WHERE id = ?').get(id)) return 'album';
  if (db.query('SELECT 1 FROM library_artists WHERE id = ?').get(id)) return 'artist';
  return null;
}

function forward(req: Request, names: string[]): HeadersInit {
  const h: Record<string, string> = {};
  for (const n of names) {
    const v = req.headers.get(n);
    if (v) h[n] = v;
  }
  return h;
}

const EXTENSIONS = [
  { name: 'apiKeyAuthentication', versions: [1] },
  { name: 'formPost', versions: [1] },
  { name: 'songLyrics', versions: [1] },
];

export function openSubsonicRoutes(deps: OpenSubsonicDeps) {
  const app = new Hono();

  async function albumList(call: Call): Promise<LibraryAlbum[]> {
    const { p, api, db, user } = call;
    const type = p.require('type');
    const size = p.int('size', 10, MAX_LIST) || 10;
    const offset = p.int('offset', 0);
    if (type === 'starred') {
      const ids = [...starredItems(db, user.id, 'album').keys()].slice(offset, offset + size);
      return albumsById(api, ids);
    }
    const q = new URLSearchParams({
      classification: 'any',
      size: String(size),
      offset: String(offset),
    });
    switch (type) {
      case 'random':
      case 'newest':
      case 'alphabeticalByName':
      case 'alphabeticalByArtist':
        q.set('type', type);
        break;
      case 'byYear': {
        const from = p.int('fromYear', 0);
        const to = p.int('toYear', 9999);
        q.set('type', 'byYear');
        q.set('yearMin', String(Math.min(from, to)));
        q.set('yearMax', String(Math.max(from, to)));
        break;
      }
      case 'byGenre':
        q.set('type', 'alphabeticalByName');
        q.set('genre', p.require('genre'));
        break;
      // No per-user play counts or ratings behind the album grid yet: these
      // answer with the newest albums rather than an error a client cannot handle.
      case 'recent':
      case 'frequent':
      case 'highest':
        q.set('type', 'newest');
        break;
      default:
        throw new SubsonicFail(SubsonicError.Generic, `Unknown album list type: ${type}`);
    }
    return api.json<LibraryAlbum[]>(`/api/library/albums?${q}`);
  }

  async function search(call: Call) {
    const { p, api } = call;
    const query = (p.get('query') ?? '')
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .trim();
    const artistCount = p.int('artistCount', 20, MAX_LIST);
    const artistOffset = p.int('artistOffset', 0);
    const albumCount = p.int('albumCount', 20, MAX_LIST);
    const albumOffset = p.int('albumOffset', 0);
    const songCount = p.int('songCount', 20, MAX_LIST);
    const songOffset = p.int('songOffset', 0);
    const stars = call.stars();

    if (query === '') {
      // An empty query lists the whole library, page by page — how Music
      // Assistant and offline-sync clients enumerate it.
      const artists =
        artistCount > 0
          ? (await api.json<Artist[]>(ARTISTS_ALL)).slice(artistOffset, artistOffset + artistCount)
          : [];
      const albums =
        albumCount > 0
          ? await api.json<LibraryAlbum[]>(
              `/api/library/albums?classification=any&type=alphabeticalByArtist&size=${albumCount}&offset=${albumOffset}`,
            )
          : [];
      const songs: Song[] = [];
      // /api/library/songs pages at 200, so a larger page is several calls.
      while (songs.length < songCount) {
        const want = Math.min(200, songCount - songs.length);
        const page = await api.json<Song[]>(
          `/api/library/songs?sort=album&size=${want}&offset=${songOffset + songs.length}`,
        );
        songs.push(...page);
        if (page.length < want) break;
      }
      return {
        artist: artists.map((a) => toArtistID3(a, stars)),
        album: albums.map((a) => toAlbumID3(a, stars)),
        song: songs.map((s) => toChild(s, stars)),
      };
    }

    const found = (await deps.searchLibrary(query)) ?? { artists: [], albums: [], songs: [] };
    const songIds = found.songs.slice(songOffset, songOffset + songCount).map((s) => s.id);
    const songs = await resolveSongs(api, songIds);
    // The search provider's album rows are slim (no created/duration); a
    // client validating AlbumID3 rejects the whole result over one of them.
    const albums = await albumsById(
      api,
      found.albums.slice(albumOffset, albumOffset + albumCount).map((a) => a.id),
    );
    return {
      artist: found.artists
        .slice(artistOffset, artistOffset + artistCount)
        .map((a) => toArtistID3(a as Artist, stars)),
      album: albums.map((a) => toAlbumID3(a, stars)),
      song: songs.map((s) => toChild(s, stars)),
    };
  }

  async function starred(call: Call) {
    const { api, db, user } = call;
    const stars = call.stars();
    const songs = await resolveSongs(api, [...stars.songs.keys()].slice(0, 2000));
    const albums = await albumsById(api, [...starredItems(db, user.id, 'album').keys()]);
    const artistIds = stars.artists;
    const artists =
      artistIds.size > 0
        ? (await api.json<Artist[]>(ARTISTS_ALL)).filter((a) => artistIds.has(a.id))
        : [];
    return {
      artist: artists.map((a) => toArtistID3(a, stars)),
      album: albums.map((a) => toAlbumID3(a, stars)),
      song: songs.map((s) => toChild(s, stars)),
    };
  }

  async function setStar(call: Call, on: boolean): Promise<SubsonicPayload> {
    const { p, api, db, user } = call;
    const targets: Array<['song' | 'album' | 'artist', string]> = [];
    for (const id of p.all('id')) {
      const kind = itemKind(db, id);
      if (!kind) throw new SubsonicFail(SubsonicError.NotFound, `Not found: ${id}`);
      targets.push([kind, id]);
    }
    for (const id of p.all('albumId')) targets.push(['album', id]);
    for (const id of p.all('artistId')) targets.push(['artist', id]);
    for (const [kind, id] of targets) {
      if (kind === 'song') {
        await api.send(on ? 'POST' : 'DELETE', `/api/library/songs/${enc(id)}/like`);
      } else if (on) {
        starItem(db, user.id, kind, id);
      } else {
        unstarItem(db, user.id, kind, id);
      }
    }
    return {};
  }

  async function similar(call: Call, key: 'similarSongs' | 'similarSongs2') {
    const { p, api, db } = call;
    const id = p.require('id');
    const count = p.int('count', 50, 50) || 50;
    const stars = call.stars();
    const kind = itemKind(db, id);
    let songs: Song[];
    if (kind === 'song') {
      songs = await api.json<Song[]>(`/api/library/songs/${enc(id)}/similar?size=${count}`);
    } else if (kind === 'album') {
      const album = await api.json<AlbumDetail>(`/api/library/albums/${enc(id)}`);
      const seed = album.song[0];
      songs = seed
        ? await api.json<Song[]>(`/api/library/songs/${enc(seed.id)}/similar?size=${count}`)
        : [];
    } else if (kind === 'artist') {
      // An artist seed: their own catalogue, shuffled — the closest the
      // song-seeded scorer gets without picking one track to stand for them.
      const own = await api.json<Song[]>(`/api/library/artists/${enc(id)}/songs?size=200`);
      songs = shuffle(own).slice(0, count);
    } else {
      throw new SubsonicFail(SubsonicError.NotFound, 'Requested data was not found');
    }
    return { [key]: { song: songs.map((s) => toChild(s, stars)) } };
  }

  async function lyricsFor(api: Api, songId: string): Promise<LyricsDto | null> {
    return api.json<LyricsDto | null>(`/api/library/songs/${enc(songId)}/lyrics`);
  }

  const methods: Record<string, Handler> = {
    ping: async () => ({}),
    getLicense: async () => ({ license: { valid: true } }),
    getOpenSubsonicExtensions: async () => ({ openSubsonicExtensions: EXTENSIONS }),

    getUser: async ({ p, user }) => {
      const name = p.require('username');
      if (name.toLowerCase() !== user.username.toLowerCase()) {
        throw new SubsonicFail(
          SubsonicError.NotAuthorized,
          'User is not authorized for the given operation',
        );
      }
      return {
        user: {
          username: user.username,
          scrobblingEnabled: true,
          adminRole: user.role === 'admin',
          settingsRole: false,
          downloadRole: true,
          uploadRole: false,
          playlistRole: true,
          coverArtRole: false,
          commentRole: false,
          podcastRole: false,
          streamRole: true,
          jukeboxRole: false,
          shareRole: false,
          videoConversionRole: false,
          folder: [1],
        },
      };
    },

    getMusicFolders: async () => ({ musicFolders: { musicFolder: [{ id: 1, name: 'Music' }] } }),

    getArtists: async ({ api, stars }) => {
      const s = stars();
      const artists = (await api.json<Artist[]>(ARTISTS_ALL)).map((a) => toArtistID3(a, s));
      return {
        artists: { ignoredArticles: IGNORED_ARTICLES.join(' '), index: artistIndex(artists) },
      };
    },

    getIndexes: async ({ api, stars }) => {
      const s = stars();
      const artists = (await api.json<Artist[]>(ARTISTS_ALL)).map((a) => ({
        id: a.id,
        name: a.name,
        starred: s.artists.get(a.id),
      }));
      return {
        indexes: {
          ignoredArticles: IGNORED_ARTICLES.join(' '),
          lastModified: Date.now(),
          index: artistIndex(artists),
        },
      };
    },

    getArtist: async ({ p, api, stars }) => {
      const d = await api.json<ArtistDetail>(`/api/library/artists/${enc(p.require('id'))}`);
      const s = stars();
      const albums = [...d.albums, ...d.singlesAndEps];
      return {
        artist: {
          ...toArtistID3({ ...d.artist, albumCount: albums.length }, s),
          album: albums.map((a) => toAlbumID3(a, s)),
        },
      };
    },

    getArtistInfo: async (call) => ({ artistInfo: await artistInfo(call) }),
    getArtistInfo2: async (call) => ({ artistInfo2: await artistInfo(call) }),

    getAlbum: async ({ p, api, stars }) => {
      const d = await api.json<AlbumDetail>(`/api/library/albums/${enc(p.require('id'))}`);
      const s = stars();
      return { album: { ...toAlbumID3(d, s), song: d.song.map((x) => toChild(x, s)) } };
    },

    getAlbumInfo: async ({ p, db }) => albumInfo(db, p, 'albumInfo'),
    getAlbumInfo2: async ({ p, db }) => albumInfo(db, p, 'albumInfo'),

    getSong: async ({ p, api, stars }) => ({
      song: toChild(await api.json<Song>(`/api/library/songs/${enc(p.require('id'))}`), stars()),
    }),

    getMusicDirectory: async ({ p, api, db, stars }) => {
      const id = p.require('id');
      const s = stars();
      const kind = itemKind(db, id);
      if (kind === 'artist') {
        const d = await api.json<ArtistDetail>(`/api/library/artists/${enc(id)}`);
        return {
          directory: {
            id,
            name: d.artist.name,
            starred: s.artists.get(id),
            child: [...d.albums, ...d.singlesAndEps].map((a) => ({
              ...toAlbumID3(a, s),
              parent: id,
            })),
          },
        };
      }
      if (kind === 'album') {
        const d = await api.json<AlbumDetail>(`/api/library/albums/${enc(id)}`);
        return {
          directory: {
            id,
            parent: d.artistId,
            name: d.name,
            starred: s.albums.get(id),
            child: d.song.map((x) => toChild(x, s)),
          },
        };
      }
      throw new SubsonicFail(SubsonicError.NotFound, 'Requested data was not found');
    },

    getGenres: async ({ api }) => {
      const genres =
        await api.json<Array<{ value: string; songCount: number; albumCount: number }>>(
          '/api/library/genres',
        );
      return { genres: { genre: genres } };
    },

    getAlbumList: async (call) => {
      const s = call.stars();
      return { albumList: { album: (await albumList(call)).map((a) => toAlbumID3(a, s)) } };
    },
    getAlbumList2: async (call) => {
      const s = call.stars();
      return { albumList2: { album: (await albumList(call)).map((a) => toAlbumID3(a, s)) } };
    },

    getRandomSongs: async ({ p, api, stars }) => {
      const size = p.int('size', 10, MAX_LIST) || 10;
      const genre = p.get('genre');
      const fromYear = p.get('fromYear');
      const toYear = p.get('toYear');
      let songs: Song[];
      if (genre || fromYear || toYear) {
        const q = new URLSearchParams({ size: '200' });
        if (genre) q.set('genre', genre);
        if (fromYear) q.set('yearMin', fromYear);
        if (toYear) q.set('yearMax', toYear);
        songs = shuffle(await api.json<Song[]>(`/api/library/songs?${q}`)).slice(0, size);
      } else {
        songs = await api.json<Song[]>(`/api/library/random?size=${Math.min(size, 200)}`);
      }
      const s = stars();
      return { randomSongs: { song: songs.map((x) => toChild(x, s)) } };
    },

    getSongsByGenre: async ({ p, api, stars }) => {
      const genre = p.require('genre');
      const count = p.int('count', 10, MAX_LIST) || 10;
      const offset = p.int('offset', 0);
      const songs = await api.json<Song[]>(
        `/api/library/genres/songs?genre=${enc(genre)}&count=${offset + count}`,
      );
      const s = stars();
      return { songsByGenre: { song: songs.slice(offset).map((x) => toChild(x, s)) } };
    },

    search2: async (call) => ({ searchResult2: await search(call) }),
    search3: async (call) => ({ searchResult3: await search(call) }),

    getStarred: async (call) => ({ starred: await starred(call) }),
    getStarred2: async (call) => ({ starred2: await starred(call) }),
    star: (call) => setStar(call, true),
    unstar: (call) => setStar(call, false),

    scrobble: async ({ p, api, user }) => {
      // `submission=false` is a now-playing ping; NicotinD's presence comes
      // from its own players, so only completed plays are recorded.
      if (p.get('submission') === 'false') return {};
      const ids = p.all('id');
      if (ids.length === 0) p.require('id');
      const times = p.all('time');
      const songs = new Map((await resolveSongs(api, ids)).map((s) => [s.id, s]));
      const client = p.get('c') ?? 'subsonic';
      const events = ids.flatMap((id, i) => {
        const song = songs.get(id);
        if (!song) return [];
        const at = Number(times[i]) || Date.now();
        const durationMs = song.duration * 1000;
        return [
          {
            // Deterministic, so a client that retries a scrobble does not double count.
            clientEventId: `subsonic:${user.id}:${id}:${at}`,
            songId: id,
            startedAt: at,
            msPlayed: durationMs,
            durationMs,
            reason: 'ended',
            source: 'subsonic',
            device: client.slice(0, 100),
            title: song.title,
            artist: song.artist,
            album: song.album,
          },
        ];
      });
      if (events.length > 0) await api.send('POST', '/api/history/plays', { events });
      return {};
    },

    getPlaylists: async ({ api, user }) => {
      const { playlists } = await api.json<{ playlists: PlaylistSummary[] }>('/api/playlists');
      return { playlists: { playlist: playlists.map((pl) => playlistEntry(pl, user.username)) } };
    },

    getPlaylist: async ({ p, api, user, stars }) => {
      const d = await api.json<PlaylistDetail>(`/api/playlists/${enc(p.require('id'))}`);
      const s = stars();
      const duration = d.songs.reduce((sum, x) => sum + (x.duration || 0), 0);
      return {
        playlist: {
          ...playlistEntry({ ...d, songCount: d.songs.length }, user.username, duration),
          entry: d.songs.map((x) => toChild(x, s)),
        },
      };
    },

    createPlaylist: async (call) => {
      const { p, api } = call;
      const songIds = p.all('songId');
      const existing = p.get('playlistId');
      let id: string;
      if (existing) {
        // createPlaylist with an id replaces that playlist's songs.
        const d = await api.json<PlaylistDetail>(`/api/playlists/${enc(existing)}`);
        const name = p.get('name');
        await api.send('PUT', `/api/playlists/${enc(existing)}`, {
          ...(name ? { name } : {}),
          remove: d.songs.map((x) => x.id).filter((x) => !songIds.includes(x)),
          add: songIds,
          reorder: songIds,
        });
        id = existing;
      } else {
        const res = await api.send<{ playlist: { id: string } }>('POST', '/api/playlists', {
          name: p.require('name'),
          songIds,
        });
        id = res.playlist.id;
      }
      call.p = new Params({ id: [id] });
      return methods.getPlaylist!(call);
    },

    updatePlaylist: async ({ p, api }) => {
      const id = p.require('playlistId');
      const d = await api.json<PlaylistDetail>(`/api/playlists/${enc(id)}`);
      const removeIdx = new Set(p.all('songIndexToRemove').map(Number));
      const remove = d.songs.filter((_, i) => removeIdx.has(i)).map((x) => x.id);
      const name = p.get('name');
      const comment = p.get('comment');
      await api.send('PUT', `/api/playlists/${enc(id)}`, {
        ...(name !== undefined ? { name } : {}),
        ...(comment !== undefined ? { description: comment } : {}),
        add: p.all('songIdToAdd'),
        remove,
      });
      return {};
    },

    deletePlaylist: async ({ p, api }) => {
      await api.send('DELETE', `/api/playlists/${enc(p.require('id'))}`);
      return {};
    },

    getLyricsBySongId: async ({ p, api }) => {
      const id = p.require('id');
      const song = await api.json<Song>(`/api/library/songs/${enc(id)}`);
      const lyrics = await lyricsFor(api, id);
      const structured = [];
      const synced = parseLrc(lyrics?.synced);
      if (synced.length > 0) {
        structured.push({
          lang: 'xxx',
          synced: true,
          offset: lyrics?.offsetMs ?? 0,
          displayArtist: song.artist,
          displayTitle: song.title,
          line: synced.map((l) => ({ start: l.timeMs, value: l.text })),
        });
      }
      if (lyrics?.plain) {
        structured.push({
          lang: 'xxx',
          synced: false,
          displayArtist: song.artist,
          displayTitle: song.title,
          line: lyrics.plain.split(/\r?\n/).map((value) => ({ value })),
        });
      }
      return { lyricsList: { structuredLyrics: structured } };
    },

    getLyrics: async ({ p, api }) => {
      const artist = p.get('artist') ?? '';
      const title = p.get('title') ?? '';
      const found = await deps.searchLibrary(`${artist} ${title}`.trim());
      const hit = found?.songs.find(
        (s) =>
          s.title.toLowerCase() === title.toLowerCase() &&
          (!artist || s.artist.toLowerCase() === artist.toLowerCase()),
      );
      const lyrics = hit ? await lyricsFor(api, hit.id) : null;
      return {
        lyrics: lyrics?.plain
          ? { artist: hit?.artist, title: hit?.title, value: lyrics.plain }
          : {},
      };
    },

    getSimilarSongs: (call) => similar(call, 'similarSongs'),
    getSimilarSongs2: (call) => similar(call, 'similarSongs2'),

    getTopSongs: async ({ p, api, stars }) => {
      const name = p.require('artist');
      const count = p.int('count', 50, MAX_LIST) || 50;
      const ref = await api
        .json<{ id: string }>(`/api/library/artists/by-name?name=${enc(name)}`)
        .catch(() => null);
      if (!ref) return { topSongs: {} };
      const songs = await api.json<Array<Song & { popularity?: number }>>(
        `/api/library/artists/${enc(ref.id)}/songs?size=200`,
      );
      const top = songs
        .map((x, i) => ({ x, i }))
        .sort((a, b) => (b.x.popularity ?? -1) - (a.x.popularity ?? -1) || a.i - b.i)
        .slice(0, count)
        .map(({ x }) => x);
      const s = stars();
      return { topSongs: { song: top.map((x) => toChild(x, s)) } };
    },

    getScanStatus: async ({ db }) => ({
      scanStatus: {
        scanning: false,
        count: db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM library_songs').get()?.n ?? 0,
      },
    }),

    // Features NicotinD does not have answer empty, the way a Subsonic server
    // with none configured does — a client then simply hides the section.
    getNowPlaying: async () => ({ nowPlaying: {} }),
    getInternetRadioStations: async () => ({ internetRadioStations: {} }),
    getPodcasts: async () => ({ podcasts: {} }),
    getNewestPodcasts: async () => ({ newestPodcasts: {} }),
    getBookmarks: async () => ({ bookmarks: {} }),
    getPlayQueue: async () => ({}),
    getShares: async () => ({ shares: {} }),

    stream: async ({ p, api, req }) => {
      const q = new URLSearchParams();
      const format = p.get('format');
      if (format) q.set('format', format);
      const kbps = p.int('maxBitRate', 0);
      if (kbps > 0) q.set('maxBitRate', String(kbps));
      return media(api, `/api/stream/${enc(p.require('id'))}?${q}`, req);
    },

    download: async ({ p, api, req }) =>
      media(api, `/api/stream/${enc(p.require('id'))}?format=raw`, req),

    getCoverArt: async ({ p, api, req }) => {
      const size = p.int('size', 0);
      const q = size > 0 ? `?size=${size}` : '';
      return media(api, `/api/cover/${enc(p.require('id'))}${q}`, req);
    },
  };

  async function artistInfo({ p, api }: Call) {
    const d = await api.json<ArtistDetail>(`/api/library/artists/${enc(p.require('id'))}`);
    return { biography: d.artist.bio ?? undefined };
  }

  function albumInfo(db: Database, p: Params, key: string): SubsonicPayload {
    const id = p.require('id');
    if (!db.query('SELECT 1 FROM library_albums WHERE id = ?').get(id)) {
      throw new SubsonicFail(SubsonicError.NotFound, 'Requested data was not found');
    }
    return { [key]: {} };
  }

  /** Pass a media response through untouched — Range, 206 and caching included. */
  async function media(api: Api, path: string, req: Request): Promise<Response> {
    const res = await api.raw(path, { headers: forward(req, ['range', 'if-range']) });
    if (res.status === 404)
      throw new SubsonicFail(SubsonicError.NotFound, 'Requested data was not found');
    if (res.status === 401 || res.status === 403) {
      throw new SubsonicFail(
        SubsonicError.NotAuthorized,
        'User is not authorized for the given operation',
      );
    }
    return res;
  }

  /** Methods a client may call before signing in. */
  const PUBLIC = new Set(['getOpenSubsonicExtensions']);

  app.all('/:method', async (c) => {
    const method = c.req.param('method').replace(/\.view$/, '');
    let format: SubsonicFormat = pickFormat(c.req.query('f'));
    try {
      const p = await readParams(c);
      format = pickFormat(p.get('f'));
      const handler = Object.hasOwn(methods, method) ? methods[method] : undefined;
      if (!handler) {
        // Not an auth failure, and not a 404 page: an unimplemented method is
        // an error the client can read and degrade on.
        return renderSubsonicError(
          format,
          deps.serverVersion,
          SubsonicError.NotFound,
          `Unknown method: ${method}`,
        );
      }
      const db = deps.getDb();
      const user = PUBLIC.has(method)
        ? { id: '', username: '', role: 'listener' }
        : authenticate(db, p);
      let stars: StarLookup | null = null;
      const call: Call = {
        p,
        user,
        db,
        req: c.req.raw,
        api: makeApi(deps.upstream, user),
        stars: () => (stars ??= loadStars(db, user.id)),
      };
      const out = await handler(call);
      return out instanceof Response ? out : renderSubsonic(format, deps.serverVersion, out);
    } catch (err) {
      if (err instanceof SubsonicFail) {
        return renderSubsonicError(format, deps.serverVersion, err.code, err.message);
      }
      log.error({ err, method }, 'opensubsonic call failed');
      return renderSubsonicError(
        format,
        deps.serverVersion,
        SubsonicError.Generic,
        'Internal error',
      );
    }
  });

  return app;
}
