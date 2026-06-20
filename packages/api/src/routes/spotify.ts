import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { createLogger, NicotinDError } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import type { SpotifySearchService } from '../services/spotify-search.service.js';
import type { PluginRegistry } from '../services/plugins/registry.js';

const log = createLogger('spotify');

export interface SpotifyRoutesOptions {
  search: SpotifySearchService;
  plugins: PluginRegistry;
}

/** Plugin id of the Spotify metadata plugin (the gate for this lane). */
const SPOTIFY_PLUGIN_ID = 'spotify';

export function spotifyRoutes({ search, plugins }: SpotifyRoutesOptions) {
  const app = new Hono<AuthEnv>();

  // GET /api/spotify/search?q=               (free text — unified search)
  // GET /api/spotify/search?artist=&album=   (targeted — album-hunt modal)
  //
  // Gated specifically on the Spotify plugin being enabled (an independent
  // fallback lane, like archive.org — not the generic download-capability gate).
  // Downloading a result is spotDL's job; this lane only finds the Spotify URL.
  app.get('/search', async (c) => {
    if (!plugins.isEnabled(SPOTIFY_PLUGIN_ID)) {
      return c.json(
        { error: 'Spotify is disabled — enable + configure it in Settings → Plugins' },
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
      // Upstream Spotify failure / missing creds → 503 so the UI shows
      // "unavailable" rather than the misleading "no results" an empty 200 implies.
      const status = (err instanceof NicotinDError ? err.statusCode : 500) as ContentfulStatusCode;
      log.warn({ q, artist, album, err: msg }, 'Spotify search failed');
      return c.json({ error: msg }, status);
    }
  });

  return app;
}
