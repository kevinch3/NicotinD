import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { catalogRoutes } from './catalog.js';
import type { CatalogService } from '../services/catalog-search.service.js';

function makeCatalogMock(over: Partial<Record<keyof CatalogService, unknown>> = {}) {
  return {
    search: mock(async () => ({ artists: [], albums: [] })),
    resolveAlbum: mock(async () => ({
      lidarrAlbumId: 1,
      totalTracks: 1,
      title: 'A',
      artistName: 'B',
    })),
    ...over,
  } as unknown as CatalogService;
}

function makeApp(catalog: CatalogService): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('*', (c, next) => {
    c.set('user', { sub: 'u', role: 'admin', iat: 0, exp: 9999999999 });
    return next();
  });
  app.route('/', catalogRoutes({ catalog }));
  return app;
}

describe('catalog routes', () => {
  let app: Hono<AuthEnv>;
  let catalog: CatalogService;

  beforeEach(() => {
    catalog = makeCatalogMock();
    app = makeApp(catalog);
  });

  it('GET /search returns catalog results', async () => {
    catalog = makeCatalogMock({
      search: mock(async () => ({ artists: [{ mbid: 'm', name: 'Floyd' }], albums: [] })),
    });
    app = makeApp(catalog);

    const res = await app.request('/search?q=floyd');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artists: Array<{ name: string }> };
    expect(body.artists[0]?.name).toBe('Floyd');
  });

  it('GET /search 400s without a query', async () => {
    const res = await app.request('/search');
    expect(res.status).toBe(400);
  });

  it('POST /resolve returns the resolved album id', async () => {
    const res = await app.request('/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        foreignAlbumId: 'rg',
        artistMbid: 'm',
        artistName: 'Floyd',
        albumTitle: 'Animals',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lidarrAlbumId: number };
    expect(body.lidarrAlbumId).toBe(1);
  });

  it('POST /resolve 400s when required fields are missing', async () => {
    const res = await app.request('/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ albumTitle: 'Animals' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /resolve surfaces service errors as 500', async () => {
    catalog = makeCatalogMock({
      resolveAlbum: mock(async () => {
        throw new Error('not yet available');
      }),
    });
    app = makeApp(catalog);

    const res = await app.request('/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ foreignAlbumId: 'rg', artistName: 'Floyd' }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not yet available/);
  });
});
