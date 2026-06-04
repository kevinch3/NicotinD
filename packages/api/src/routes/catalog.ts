import { Hono } from 'hono';
import { createLogger } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import type { CatalogService } from '../services/catalog-search.service.js';

const log = createLogger('catalog');

export interface CatalogRoutesOptions {
  catalog: CatalogService;
}

export function catalogRoutes({ catalog }: CatalogRoutesOptions) {
  const app = new Hono<AuthEnv>();

  // GET /api/catalog/search?q=
  // Metadata-driven search: looks the query up against Lidarr/MusicBrainz and
  // returns structured artist + album candidates. Read-only — adds nothing to
  // Lidarr (that happens on resolve).
  app.get('/search', async (c) => {
    const query = c.req.query('q');
    if (!query) return c.json({ error: 'Query parameter "q" is required' }, 400);

    try {
      const result = await catalog.search(query);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ query, err: msg }, 'Catalog search failed');
      return c.json({ error: msg }, 500);
    }
  });

  // POST /api/catalog/resolve
  // Resolves a searched album into a real Lidarr album id (adding the artist on
  // demand if needed) so the existing album-hunt flow can run against its
  // canonical tracklist. Body: { foreignAlbumId, artistMbid, artistName, albumTitle }
  app.post('/resolve', async (c) => {
    const body = await c.req
      .json<{
        foreignAlbumId?: string;
        artistMbid?: string;
        artistName?: string;
        albumTitle?: string;
      }>()
      .catch(() => null);

    if (!body?.foreignAlbumId || !body.artistName) {
      return c.json({ error: 'Missing foreignAlbumId or artistName' }, 400);
    }

    try {
      const result = await catalog.resolveAlbum({
        foreignAlbumId: body.foreignAlbumId,
        artistMbid: body.artistMbid ?? '',
        artistName: body.artistName,
        albumTitle: body.albumTitle ?? '',
      });
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ album: body.albumTitle, err: msg }, 'Catalog resolve failed');
      return c.json({ error: msg }, 500);
    }
  });

  return app;
}
