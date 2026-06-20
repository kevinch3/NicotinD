import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { spotifyRoutes } from './spotify.js';
import { SpotifySearchService } from '../services/spotify-search.service.js';
import type { PluginRegistry } from '../services/plugins/registry.js';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';

const SEARCH_BODY = {
  albums: {
    items: [
      {
        id: 'alb1',
        name: 'Hot Shot',
        album_type: 'album',
        total_tracks: 14,
        release_date: '2000',
        artists: [{ name: 'Shaggy' }],
        external_urls: { spotify: 'https://open.spotify.com/album/alb1' },
      },
    ],
  },
};

function fetchMock(searchOk = true) {
  const fn = mock(async (url: string) => {
    if (url === TOKEN_URL) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'tok', expires_in: 3600 }),
      };
    }
    return { ok: searchOk, status: searchOk ? 200 : 500, json: async () => SEARCH_BODY };
  }) as unknown as typeof fetch;
  return fn;
}

function fakePlugins(enabled: boolean): PluginRegistry {
  return { isEnabled: (id: string) => id === 'spotify' && enabled } as unknown as PluginRegistry;
}

function makeApp(opts: { enabled: boolean; fetchFn: typeof fetch; creds?: boolean }) {
  const app = new Hono<AuthEnv>();
  app.use('*', (c, next) => {
    c.set('user', { sub: 'u1', role: 'user', iat: 0, exp: 9999999999 });
    return next();
  });
  const creds =
    opts.creds === false
      ? { clientId: '', clientSecret: '' }
      : { clientId: 'i', clientSecret: 's' };
  app.route(
    '/api/spotify',
    spotifyRoutes({
      search: new SpotifySearchService(() => creds, opts.fetchFn),
      plugins: fakePlugins(opts.enabled),
    }),
  );
  return app;
}

describe('spotify routes', () => {
  it('503s when the spotify plugin is disabled', async () => {
    const app = makeApp({ enabled: false, fetchFn: fetchMock() });
    const res = await app.request('/api/spotify/search?q=foo');
    expect(res.status).toBe(503);
  });

  it('returns candidates for a free-text query when enabled', async () => {
    const app = makeApp({ enabled: true, fetchFn: fetchMock() });
    const res = await app.request('/api/spotify/search?q=shaggy');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: unknown[] };
    expect(body.candidates).toHaveLength(1);
  });

  it('returns candidates for an artist/album query', async () => {
    const app = makeApp({ enabled: true, fetchFn: fetchMock() });
    const res = await app.request('/api/spotify/search?artist=Shaggy&album=Hot+Shot');
    expect(res.status).toBe(200);
  });

  it('400s when neither q nor artist/album is provided', async () => {
    const app = makeApp({ enabled: true, fetchFn: fetchMock() });
    const res = await app.request('/api/spotify/search');
    expect(res.status).toBe(400);
  });

  it('503s when credentials are not configured', async () => {
    const app = makeApp({ enabled: true, fetchFn: fetchMock(), creds: false });
    const res = await app.request('/api/spotify/search?q=foo');
    expect(res.status).toBe(503);
  });

  it('503s when the Spotify upstream keeps failing', async () => {
    const app = makeApp({ enabled: true, fetchFn: fetchMock(false) });
    const res = await app.request('/api/spotify/search?q=foo');
    expect(res.status).toBe(503);
  });
});
