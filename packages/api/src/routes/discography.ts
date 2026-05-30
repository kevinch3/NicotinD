import { Hono } from 'hono';
import { createLogger } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import type { DiscographyService } from '../services/discography.service.js';
import type { AlbumHunterService } from '../services/album-hunter.service.js';
import type { Lidarr } from '@nicotind/lidarr-client';

const log = createLogger('discography');

export interface DiscographyRoutesOptions {
  discography: DiscographyService;
  hunter: AlbumHunterService;
  lidarr: Lidarr;
}

export function discographyRoutes({
  discography,
  hunter,
  lidarr,
}: DiscographyRoutesOptions) {
  const app = new Hono<AuthEnv>();

  // GET /api/discography/artists/:id
  // Returns complete discography for a local library artist, diffed against Lidarr
  app.get('/artists/:id', async (c) => {
    const { id } = c.req.param();
    try {
      const result = await discography.getArtistDiscography(id);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ artistId: id, err: msg }, 'Discography lookup failed');
      return c.json({ error: msg }, 500);
    }
  });

  // POST /api/discography/albums/:lidarrAlbumId/hunt
  // Searches Soulseek for folder candidates matching the album tracklist.
  // Returns ALL candidates above a low floor (each tagged isLive); the client
  // applies FLAC/live/min-match filtering reactively. Optional body overrides:
  // { artistName?, albumTitle? }
  app.post('/albums/:lidarrAlbumId/hunt', async (c) => {
    const { lidarrAlbumId } = c.req.param();
    const albumId = Number(lidarrAlbumId);
    if (Number.isNaN(albumId)) return c.json({ error: 'Invalid album ID' }, 400);

    const body = await c.req
      .json<{ artistName?: string; albumTitle?: string }>()
      .catch(() => ({}) as { artistName?: string; albumTitle?: string });

    try {
      const [album, tracks] = await Promise.all([
        lidarr.album.get(albumId),
        lidarr.track.listByAlbum(albumId),
      ]);

      const artistName = body.artistName ?? album.artist?.artistName ?? '';
      const albumTitle = body.albumTitle ?? album.title;

      const candidates = await hunter.hunt(artistName, albumTitle, tracks);

      return c.json({ candidates, totalTracks: tracks.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ albumId, err: msg }, 'Album hunt failed');
      return c.json({ error: msg }, 500);
    }
  });

  return app;
}
