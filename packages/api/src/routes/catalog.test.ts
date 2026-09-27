import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { NicotinDError } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { catalogRoutes } from './catalog.js';
import type { CatalogService } from '../services/catalog-search.service.js';
import type { ArtistProvisioningService } from '../services/artist-provisioning.service.js';

function makeProvisioning(start: 'started' | 'busy' = 'started') {
  return {
    start: mock(() => start),
    getStatus: () => ({ phase: 'running' }),
  } as unknown as ArtistProvisioningService;
}

function makeCatalogMock(over: Partial<Record<keyof CatalogService, unknown>> = {}) {
  return {
    search: mock(async () => ({ artists: [], albums: [] })),
    resolveAlbum: mock(async () => ({
      lidarrAlbumId: 1,
      totalTracks: 1,
      title: 'A',
      artistName: 'B',
    })),
    loadDiscography: mock(async () => ({
      artists: [],
      albums: [{ foreignAlbumId: 'rg', title: 'Poster Girl', artistName: 'Zara Larsson' }],
      scopedArtist: 'Zara Larsson',
    })),
    ...over,
  } as unknown as CatalogService;
}

function makeApp(
  catalog: CatalogService,
  provisioning: ArtistProvisioningService = makeProvisioning(),
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('*', (c, next) => {
    c.set('user', { sub: 'u', username: 'kevin', role: 'admin', iat: 0, exp: 9999999999 });
    return next();
  });
  app.route('/', catalogRoutes({ catalog, provisioning }));
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

  it('POST /discography returns the loaded albums', async () => {
    const res = await app.request('/discography', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artistMbid: 'm', artistName: 'Zara Larsson' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { albums: Array<{ title: string }>; scopedArtist: string };
    expect(body.albums[0]?.title).toBe('Poster Girl');
    expect(body.scopedArtist).toBe('Zara Larsson');
  });

  it('POST /discography 400s without artistName', async () => {
    const res = await app.request('/discography', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artistMbid: 'm' }),
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

  it('POST /resolve returns the typed code for ALBUM_NOT_IN_LIDARR (404)', async () => {
    catalog = makeCatalogMock({
      resolveAlbum: mock(async () => {
        throw new NicotinDError(
          `"The Best of Shaggy" isn't in Shaggy's Lidarr discography yet`,
          'ALBUM_NOT_IN_LIDARR',
          404,
        );
      }),
    });
    app = makeApp(catalog);

    const res = await app.request('/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        foreignAlbumId: 'rg',
        artistName: 'Shaggy',
        albumTitle: 'The Best of Shaggy',
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.code).toBe('ALBUM_NOT_IN_LIDARR');
    expect(body.error).toMatch(/Lidarr discography/);
  });

  // Issue #644: both POSTs are a user's button press, so an artist Lidarr lacks
  // starts the add job and answers 202 instead of adding inside the request.
  describe('an artist Lidarr lacks', () => {
    const notProvisioned = {
      notProvisioned: true,
      artistName: 'Zara Larsson',
      artistMbid: 'm',
    };
    const post = (path: string) =>
      app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          foreignAlbumId: 'rg',
          artistMbid: 'm',
          artistName: 'Zara Larsson',
          albumTitle: 'Venus',
        }),
      });

    it('POST /discography starts the add job and answers 202', async () => {
      const provisioning = makeProvisioning();
      app = makeApp(
        makeCatalogMock({ loadDiscography: mock(async () => notProvisioned) }),
        provisioning,
      );
      const res = await post('/discography');
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ provisioning: true, code: 'ARTIST_PROVISIONING' });
      expect(provisioning.start).toHaveBeenCalledWith(
        { artistName: 'Zara Larsson', artistMbid: 'm' },
        'kevin',
      );
    });

    it('POST /resolve starts the add job and answers 202', async () => {
      app = makeApp(makeCatalogMock({ resolveAlbum: mock(async () => notProvisioned) }));
      const res = await post('/resolve');
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ provisioning: true });
    });

    it('answers 409 PROVISIONING_BUSY while a different artist is being added', async () => {
      app = makeApp(
        makeCatalogMock({ resolveAlbum: mock(async () => notProvisioned) }),
        makeProvisioning('busy'),
      );
      const res = await post('/resolve');
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'PROVISIONING_BUSY' });
    });
  });
});
