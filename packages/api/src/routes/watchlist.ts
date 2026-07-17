import { Hono } from 'hono';
import { createLogger } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { requireAcquirer } from '../middleware/current-user.js';
import type { WatchlistService } from '../services/watchlist.service.js';

const log = createLogger('watchlist-routes');

export function watchlistRoutes(watchlist: WatchlistService) {
  const app = new Hono<AuthEnv>();

  // Watchlist auto-hunt is acquisition — hidden from listeners, gated server-side.
  app.use('*', async (c, next) => {
    requireAcquirer(c);
    await next();
  });

  // GET /api/watchlist — list every watched album (newest first).
  app.get('/', (c) => c.json({ items: watchlist.list() }));

  // POST /api/watchlist — start watching an album. Idempotent on foreignAlbumId.
  app.post('/', async (c) => {
    type Body = {
      foreignAlbumId?: string;
      artistMbid?: string;
      artistName?: string;
      albumTitle?: string;
    };
    const body = await c.req.json<Body>().catch(() => ({}) as Body);
    if (!body.artistName || !body.albumTitle) {
      return c.json({ error: 'artistName and albumTitle are required' }, 400);
    }
    try {
      const item = watchlist.add({
        foreignAlbumId: body.foreignAlbumId ?? null,
        artistMbid: body.artistMbid ?? null,
        artistName: body.artistName,
        albumTitle: body.albumTitle,
      });
      return c.json({ item }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, 'Failed to add watchlist entry');
      return c.json({ error: msg }, 500);
    }
  });

  // DELETE /api/watchlist/:id — stop watching.
  app.delete('/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (Number.isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    return watchlist.remove(id) ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404);
  });

  return app;
}
