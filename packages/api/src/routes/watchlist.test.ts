import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { watchlistRoutes } from './watchlist.js';
import type { WatchlistService } from '../services/watchlist.service.js';

function makeMockService() {
  return {
    listMock: mock(() => [{ id: 1, artist_name: 'A', album_title: 'B' }]),
    addMock: mock((input: { artistName: string; albumTitle: string }) => ({
      id: 7,
      artist_name: input.artistName,
      album_title: input.albumTitle,
      state: 'watching',
    })),
    removeMock: mock((id: number) => id === 7),
    list() {
      return this.listMock();
    },
    add(input: { artistName: string; albumTitle: string }) {
      return this.addMock(input);
    },
    remove(id: number) {
      return this.removeMock(id);
    },
  };
}

function makeApp(svc: ReturnType<typeof makeMockService>) {
  const app = new Hono<AuthEnv>();
  app.use('*', (c, next) => {
    c.set('user', { sub: 'user1', role: 'user', iat: 0, exp: 9999999999 });
    return next();
  });
  app.route('/', watchlistRoutes(svc as unknown as WatchlistService));
  return app;
}

describe('watchlist routes', () => {
  let svc: ReturnType<typeof makeMockService>;
  let app: Hono<AuthEnv>;

  beforeEach(() => {
    svc = makeMockService();
    app = makeApp(svc);
  });

  it('GET / lists watched albums', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
    expect(svc.listMock).toHaveBeenCalled();
  });

  it('POST / adds a watch and returns 201', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artistName: 'Soda Stereo', albumTitle: 'Canción Animal', foreignAlbumId: 'fa9' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { item: { album_title: string } };
    expect(body.item.album_title).toBe('Canción Animal');
    expect(svc.addMock).toHaveBeenCalledWith(
      expect.objectContaining({ artistName: 'Soda Stereo', albumTitle: 'Canción Animal', foreignAlbumId: 'fa9' }),
    );
  });

  it('POST / rejects a body missing artist/title with 400', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ albumTitle: 'Orphan' }),
    });
    expect(res.status).toBe(400);
    expect(svc.addMock).not.toHaveBeenCalled();
  });

  it('DELETE /:id removes a watch', async () => {
    const res = await app.request('/7', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(svc.removeMock).toHaveBeenCalledWith(7);
  });

  it('DELETE /:id returns 404 for an unknown id', async () => {
    const res = await app.request('/999', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('DELETE /:id returns 400 for a non-numeric id', async () => {
    const res = await app.request('/abc', { method: 'DELETE' });
    expect(res.status).toBe(400);
  });
});
