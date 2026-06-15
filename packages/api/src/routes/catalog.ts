import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { createLogger, NicotinDError } from '@nicotind/core';
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
      // A resolvable-but-absent album (id not in the artist's Lidarr discography)
      // is a 404, not a server error — don't dump it at 500 with a scary log.
      const status = (err instanceof NicotinDError ? err.statusCode : 500) as ContentfulStatusCode;
      if (status >= 500) log.warn({ album: body.albumTitle, err: msg }, 'Catalog resolve failed');
      return c.json({ error: msg }, status);
    }
  });

  // POST /api/catalog/discography
  // Loads an artist's real discography on demand (the §A6 deep fix). Adds the
  // artist to Lidarr if absent — same mutation as resolve — so this is a POST,
  // user-initiated only. Body: { artistMbid?, artistName }
  app.post('/discography', async (c) => {
    const body = await c.req
      .json<{ artistMbid?: string; artistName?: string }>()
      .catch(() => null);

    if (!body?.artistName) return c.json({ error: 'Missing artistName' }, 400);

    try {
      const result = await catalog.loadDiscography(body.artistMbid ?? '', body.artistName);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = (err instanceof NicotinDError ? err.statusCode : 500) as ContentfulStatusCode;
      if (status >= 500) log.warn({ artist: body.artistName, err: msg }, 'Load discography failed');
      return c.json({ error: msg }, status);
    }
  });

  return app;
}
