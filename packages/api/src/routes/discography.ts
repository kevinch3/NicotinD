import { Hono } from 'hono';
import { createLogger } from '@nicotind/core';
import type { Database } from 'bun:sqlite';
import type { AuthEnv } from '../middleware/auth.js';
import type { SlskdRef } from '../index.js';
import type { DiscographyService } from '../services/discography.service.js';
import type { AlbumHunterService } from '../services/album-hunter.service.js';
import { AlbumFallbackService, type AlternateCandidate } from '../services/album-fallback.service.js';
import type { Lidarr } from '@nicotind/lidarr-client';

const log = createLogger('discography');

export interface DiscographyRoutesOptions {
  discography: DiscographyService;
  hunter: AlbumHunterService;
  lidarr: Lidarr;
  db: Database;
  slskdRef: SlskdRef;
}

export function discographyRoutes({
  discography,
  hunter,
  lidarr,
  db,
  slskdRef,
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
  // { artistName?, albumTitle? }. Pass skewSearch=true to retry with modified
  // query variants (soft-ban bypass) when the normal queries return empty.
  app.post('/albums/:lidarrAlbumId/hunt', async (c) => {
    const { lidarrAlbumId } = c.req.param();
    const albumId = Number(lidarrAlbumId);
    if (Number.isNaN(albumId)) return c.json({ error: 'Invalid album ID' }, 400);

    type HuntBody = { artistName?: string; albumTitle?: string; skewSearch?: boolean };
    const body = await c.req.json<HuntBody>().catch(() => ({}) as HuntBody);

    try {
      const [album, tracks] = await Promise.all([
        lidarr.album.get(albumId),
        lidarr.track.listByAlbum(albumId),
      ]);

      const artistName = body.artistName ?? album.artist?.artistName ?? '';
      const albumTitle = body.albumTitle ?? album.title;

      const candidates = await hunter.hunt(artistName, albumTitle, tracks, {
        skewSearch: body.skewSearch,
      });

      return c.json({ candidates, totalTracks: tracks.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ albumId, err: msg }, 'Album hunt failed');
      return c.json({ error: msg }, 500);
    }
  });

  // POST /api/discography/albums/:lidarrAlbumId/hunt-download
  // Enqueues the chosen folder candidate AND records an album job (canonical
  // tracklist + ranked alternates) so the cross-peer fallback can recover any
  // tracks the chosen peer fails to deliver.
  app.post('/albums/:lidarrAlbumId/hunt-download', async (c) => {
    const { lidarrAlbumId } = c.req.param();
    const albumId = Number(lidarrAlbumId);
    if (Number.isNaN(albumId)) return c.json({ error: 'Invalid album ID' }, 400);
    if (!slskdRef.current) return c.json({ error: 'Soulseek is not configured' }, 503);

    const body = await c.req
      .json<{
        selected: { username: string; directory: string; files: Array<{ filename: string; size: number }> };
        alternates?: AlternateCandidate[];
      }>()
      .catch(() => null);

    if (!body?.selected?.username || !body.selected.files?.length) {
      return c.json({ error: 'Missing selected candidate' }, 400);
    }

    try {
      await slskdRef.current.transfers.enqueue(body.selected.username, body.selected.files);
    } catch {
      return c.json(
        { error: `Download failed for user "${body.selected.username}" — they may be offline` },
        502,
      );
    }

    // Record the album job for fallback. Best-effort: a failure here must not
    // fail the download that already succeeded.
    try {
      const tracks = await lidarr.track.listByAlbum(albumId);
      AlbumFallbackService.recordJob(db, {
        lidarrAlbumId: albumId,
        username: body.selected.username,
        directory: body.selected.directory,
        canonicalTracks: tracks.map((t) => t.title),
        alternates: body.alternates ?? [],
      });
    } catch (err) {
      log.warn({ albumId, err }, 'Failed to record album job for fallback');
    }

    return c.json({ ok: true, queued: body.selected.files.length }, 201);
  });

  return app;
}
