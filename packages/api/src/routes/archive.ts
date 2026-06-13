import { Hono } from 'hono';
import { createLogger } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import type { ArchiveSearchService } from '../services/archive-search.service.js';
import type { PluginRegistry } from '../services/plugins/registry.js';

const log = createLogger('archive');

export interface ArchiveRoutesOptions {
  search: ArchiveSearchService;
  plugins: PluginRegistry;
}

/** Plugin id of the archive.org resolve plugin (the gate for this lane). */
const ARCHIVE_PLUGIN_ID = 'archive';

export function archiveRoutes({ search, plugins }: ArchiveRoutesOptions) {
  const app = new Hono<AuthEnv>();

  // GET /api/archive/search?q=          (free text — unified search)
  // GET /api/archive/search?artist=&album=   (targeted — album-hunt modal)
  //
  // Gated specifically on the archive plugin being enabled (not the generic
  // download-capability gate, which is slskd) so the lane works as an independent
  // fallback even when Soulseek is disabled.
  app.get('/search', async (c) => {
    if (!plugins.isEnabled(ARCHIVE_PLUGIN_ID)) {
      return c.json(
        { error: 'archive.org is disabled — enable the archive.org plugin in Settings → Plugins' },
        503,
      );
    }

    const q = c.req.query('q');
    const artist = c.req.query('artist');
    const album = c.req.query('album');

    try {
      const candidates =
        artist || album
          ? await search.searchAlbum(artist ?? '', album ?? '')
          : q
            ? await search.search(q)
            : null;
      if (candidates === null) {
        return c.json({ error: 'Provide "q" or "artist"/"album" query parameters' }, 400);
      }
      return c.json({ candidates });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ q, artist, album, err: msg }, 'archive.org search failed');
      return c.json({ error: msg }, 500);
    }
  });

  return app;
}
