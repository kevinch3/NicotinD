import { describe, expect, it, mock } from 'bun:test';
import {
  SpotifySearchService,
  buildAlbumQuery,
  kindFromTrackCount,
  releaseYear,
  mapSpotifyAlbum,
  mapSearchResponse,
  spotifyDedupeKey,
  type SpotifyCredentials,
} from './spotify-search.service.js';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';

const ALBUM = (over: Record<string, unknown> = {}) => ({
  id: 'alb1',
  name: 'Porfiado',
  album_type: 'album',
  total_tracks: 12,
  release_date: '2012-05-01',
  images: [{ url: 'https://i.scdn.co/big.jpg' }, { url: 'https://i.scdn.co/small.jpg' }],
  artists: [{ name: 'El Cuarteto de Nos' }],
  external_urls: { spotify: 'https://open.spotify.com/album/alb1' },
  ...over,
});

/**
 * URL-aware mock: the token endpoint returns an app token; `/v1/search` returns
 * `searchBody`. `tokenOk`/`searchOk` flip status to exercise the failure paths.
 */
function fetchMock(opts: {
  searchBody?: unknown;
  tokenOk?: boolean;
  searchOk?: boolean;
  searchStatus?: number;
  expiresIn?: number;
}) {
  const { searchBody = { albums: { items: [] } }, tokenOk = true, searchOk = true } = opts;
  const calls: string[] = [];
  const fn = mock(async (url: string) => {
    calls.push(url);
    if (url === TOKEN_URL) {
      return {
        ok: tokenOk,
        status: tokenOk ? 200 : 500,
        json: async () => ({ access_token: 'tok', expires_in: opts.expiresIn ?? 3600 }),
      };
    }
    return {
      ok: searchOk,
      status: opts.searchStatus ?? (searchOk ? 200 : 500),
      json: async () => searchBody,
    };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const creds = (c: Partial<SpotifyCredentials> = {}): SpotifyCredentials => ({
  clientId: 'id',
  clientSecret: 'secret',
  ...c,
});

describe('spotify pure helpers', () => {
  it('kindFromTrackCount: 1 → single, 2+ → album, null → null', () => {
    expect(kindFromTrackCount(1)).toBe('single');
    expect(kindFromTrackCount(5)).toBe('album');
    expect(kindFromTrackCount(null)).toBe(null);
    expect(kindFromTrackCount(undefined)).toBe(null);
  });

  it('releaseYear extracts the year from any precision', () => {
    expect(releaseYear('2012-05-01')).toBe('2012');
    expect(releaseYear('1998')).toBe('1998');
    expect(releaseYear(undefined)).toBe(null);
    expect(releaseYear('')).toBe(null);
  });

  it('buildAlbumQuery uses Spotify field filters and tolerates a missing piece', () => {
    expect(buildAlbumQuery('Shaggy', 'Hot Shot')).toBe('album:Hot Shot artist:Shaggy');
    expect(buildAlbumQuery('', 'Hot Shot')).toBe('album:Hot Shot');
    expect(buildAlbumQuery('Shaggy', '')).toBe('artist:Shaggy');
    expect(buildAlbumQuery('', '')).toBe('');
  });

  it('mapSpotifyAlbum maps to a candidate (largest cover first, declared kind)', () => {
    expect(mapSpotifyAlbum(ALBUM())).toEqual({
      id: 'alb1',
      url: 'https://open.spotify.com/album/alb1',
      title: 'Porfiado',
      artist: 'El Cuarteto de Nos',
      year: '2012',
      coverUrl: 'https://i.scdn.co/big.jpg',
      trackCount: 12,
      kind: 'album',
    });
  });

  it('mapSpotifyAlbum derives kind from track count when album_type is absent', () => {
    expect(mapSpotifyAlbum(ALBUM({ album_type: undefined, total_tracks: 1 })).kind).toBe('single');
  });

  it('mapSpotifyAlbum falls back to a constructed URL when external_urls is missing', () => {
    expect(mapSpotifyAlbum(ALBUM({ external_urls: undefined })).url).toBe(
      'https://open.spotify.com/album/alb1',
    );
  });

  it('spotifyDedupeKey folds diacritics + ordering to one key', () => {
    expect(spotifyDedupeKey({ artist: 'El Cuarteto De Nos', title: 'Porfiado' })).toBe(
      spotifyDedupeKey({ artist: 'el cuarteto de nos', title: 'pórfiado' }),
    );
  });

  it('mapSearchResponse dedupes duplicate releases (keeps the first)', () => {
    const out = mapSearchResponse({
      albums: {
        items: [
          ALBUM({ id: 'a', name: 'Porfiado' }),
          ALBUM({ id: 'b', name: 'Porfiado' }), // dup → dropped
          ALBUM({ id: 'c', name: 'Other Album' }),
        ],
      },
    });
    expect(out.map((c) => c.id)).toEqual(['a', 'c']);
  });
});

describe('SpotifySearchService', () => {
  it('throws ServiceUnavailableError (without calling fetch) when creds are missing', async () => {
    const { fn, calls } = fetchMock({});
    const svc = new SpotifySearchService(() => creds({ clientId: '', clientSecret: '' }), fn);
    await expect(svc.search('foo')).rejects.toThrow(/Spotify/);
    expect(calls).toHaveLength(0);
  });

  it('fetches a token then maps the album search results', async () => {
    const { fn, calls } = fetchMock({
      searchBody: { albums: { items: [ALBUM()] } },
    });
    const svc = new SpotifySearchService(() => creds(), fn);
    const out = await svc.search('cuarteto porfiado');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'alb1', title: 'Porfiado', kind: 'album' });
    expect(calls[0]).toBe(TOKEN_URL);
    expect(calls[1]).toContain('/v1/search');
    expect(decodeURIComponent(calls[1]!)).toContain('type=album');
  });

  it('searchAlbum builds a field-filtered query', async () => {
    const { fn, calls } = fetchMock({ searchBody: { albums: { items: [] } } });
    await new SpotifySearchService(() => creds(), fn).searchAlbum('Shaggy', 'Hot Shot');
    const decoded = decodeURIComponent(calls[1]!).replace(/\+/g, ' ');
    expect(decoded).toContain('q=album:Hot Shot artist:Shaggy');
  });

  it('caches the token across searches (one token fetch)', async () => {
    const { fn, calls } = fetchMock({ searchBody: { albums: { items: [] } } });
    const svc = new SpotifySearchService(() => creds(), fn);
    await svc.search('a');
    await svc.search('b');
    expect(calls.filter((u) => u === TOKEN_URL)).toHaveLength(1);
  });

  it('re-fetches the token after it expires (injected clock)', async () => {
    let clock = 0;
    const { fn, calls } = fetchMock({ searchBody: { albums: { items: [] } }, expiresIn: 3600 });
    const svc = new SpotifySearchService(
      () => creds(),
      fn,
      () => clock,
    );
    await svc.search('a');
    clock += 3600 * 1000 + 1; // past expiry (minus skew)
    await svc.search('b');
    expect(calls.filter((u) => u === TOKEN_URL)).toHaveLength(2);
  });

  it('drops a cached token on 401 so the next call re-authenticates', async () => {
    let searchStatus = 401;
    const fn = mock(async (url: string) => {
      if (url === TOKEN_URL) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'tok', expires_in: 3600 }),
        };
      }
      const status = searchStatus;
      searchStatus = 200; // the retry succeeds
      return { ok: status === 200, status, json: async () => ({ albums: { items: [] } }) };
    }) as unknown as typeof fetch;
    const svc = new SpotifySearchService(() => creds(), fn);
    await svc.search('a'); // 401 then retry OK
    // The 401 cleared the token; a follow-up search must re-auth.
    await svc.search('b');
    // tokens: initial + after-401 retry's re-auth (token was cleared) — at least 2.
    expect(
      (fn as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
        (c) => c[0] === TOKEN_URL,
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('retries once then throws when the search keeps failing', async () => {
    const { fn, calls } = fetchMock({ searchOk: false });
    await expect(new SpotifySearchService(() => creds(), fn).search('foo')).rejects.toThrow(
      /Spotify/,
    );
    // token (1) + two search attempts (initial + retry)
    expect(calls.filter((u) => u.includes('/v1/search'))).toHaveLength(2);
  });

  it('returns [] (not an error) for an empty result set', async () => {
    const { fn } = fetchMock({ searchBody: { albums: { items: [] } } });
    expect(await new SpotifySearchService(() => creds(), fn).search('foo')).toEqual([]);
  });

  it('returns [] without hitting the network for a blank query', async () => {
    const { fn, calls } = fetchMock({});
    expect(await new SpotifySearchService(() => creds(), fn).search('   ')).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
