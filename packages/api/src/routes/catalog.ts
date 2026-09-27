import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { createLogger, NicotinDError } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import type { CatalogService } from '../services/catalog-search.service.js';
import {
  provisioningResponse,
  type ArtistProvisioningService,
} from '../services/artist-provisioning.service.js';
import { isNotProvisioned } from '../services/lidarr-provision.js';

const log = createLogger('catalog');

export interface CatalogRoutesOptions {
  catalog: CatalogService;
  /** The add-artist job (issue #644); status lives at /api/discography/provisioning. */
  provisioning: ArtistProvisioningService;
}

export function catalogRoutes({ catalog, provisioning }: CatalogRoutesOptions) {
  const app = new Hono<AuthEnv>();

  // Both POSTs below are already a user's button press, so an artist Lidarr lacks
  // starts the add job here and answers 202; the web re-sends once it finishes.
  const startProvisioning = (c: Context<AuthEnv>, artistMbid: string, artistName: string) => {
    const { status, body } = provisioningResponse(
      provisioning,
      { artistName, artistMbid: artistMbid || null },
      c.get('user')?.username,
    );
    return c.json(body, status);
  };

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
  // Resolves a searched album into a real Lidarr album id so the existing
  // album-hunt flow can run against its canonical tracklist (202 while the artist
  // is being added). Body: { foreignAlbumId, artistMbid, artistName, albumTitle }
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
      if (isNotProvisioned(result)) {
        return startProvisioning(c, body.artistMbid ?? '', body.artistName);
      }
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A resolvable-but-absent album (id not in the artist's Lidarr discography)
      // is a 404, not a server error — don't dump it at 500 with a scary log.
      const status = (err instanceof NicotinDError ? err.statusCode : 500) as ContentfulStatusCode;
      if (status >= 500) log.warn({ album: body.albumTitle, err: msg }, 'Catalog resolve failed');
      // Expose the typed error code so the web can branch (e.g. auto-fall back to a
      // raw network hunt on ALBUM_NOT_IN_LIDARR) instead of string-matching the message.
      const code = err instanceof NicotinDError ? err.code : undefined;
      return c.json({ error: msg, code }, status);
    }
  });

  // POST /api/catalog/discography
  // Loads an artist's real discography on demand (the §A6 deep fix). An artist
  // Lidarr lacks starts the add job — same as resolve — so this is a POST,
  // user-initiated only. Body: { artistMbid?, artistName }
  app.post('/discography', async (c) => {
    const body = await c.req.json<{ artistMbid?: string; artistName?: string }>().catch(() => null);

    if (!body?.artistName) return c.json({ error: 'Missing artistName' }, 400);

    try {
      const result = await catalog.loadDiscography(body.artistMbid ?? '', body.artistName);
      if (isNotProvisioned(result)) {
        return startProvisioning(c, body.artistMbid ?? '', body.artistName);
      }
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
