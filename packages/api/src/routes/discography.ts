import { Hono } from 'hono';
import { createLogger } from '@nicotind/core';
import type { Database } from 'bun:sqlite';
import type { AuthEnv } from '../middleware/auth.js';
import type { SlskdRef } from '../index.js';
import type { DiscographyService } from '../services/discography.service.js';
import type { AlbumHunterService } from '../services/album-hunter.service.js';
import { AlbumFallbackService, type AlternateCandidate } from '../services/album-fallback.service.js';
import { normalizeForGrouping } from '../services/album-grouping.js';
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

  // GET /api/discography/jobs
  // Lists album hunt jobs (default: incomplete ones — exhausted or still active)
  // so the UI can surface albums that never completed and offer a re-hunt. Pass
  // ?state=exhausted|active|done|all to filter.
  app.get('/jobs', (c) => {
    const state = c.req.query('state') ?? 'incomplete';
    const select = `SELECT id, lidarr_album_id AS lidarrAlbumId, artist_name AS artistName,
                album_title AS albumTitle, username, directory, state,
                fallback_attempts AS fallbackAttempts, created_at AS createdAt
         FROM album_jobs`;
    let jobs;
    if (state === 'all') {
      jobs = db.query(`${select} ORDER BY created_at DESC`).all();
    } else if (state === 'incomplete') {
      jobs = db
        .query(`${select} WHERE state IN ('exhausted', 'active') ORDER BY created_at DESC`)
        .all();
    } else {
      jobs = db.query(`${select} WHERE state = ? ORDER BY created_at DESC`).all(state);
    }
    return c.json({ jobs });
  });

  // POST /api/discography/albums/:lidarrAlbumId/hunt-download[?replace=true]
  // Enqueues the chosen folder candidate AND records an album job (canonical
  // tracklist + ranked alternates) so the cross-peer fallback can recover any
  // tracks the chosen peer fails to deliver.
  //
  // Idempotent per lidarr_album_id — the root-cause fix for duplicate albums:
  // a second download of an album that's already in flight (active job) or
  // already complete in the library would land in a *second* folder → a second
  // card. We refuse those with 409 so one album = one download = one folder.
  // `?replace=true` (admin re-hunt) supersedes the prior active job first so we
  // never run two active jobs for the same album.
  app.post('/albums/:lidarrAlbumId/hunt-download', async (c) => {
    const { lidarrAlbumId } = c.req.param();
    const albumId = Number(lidarrAlbumId);
    if (Number.isNaN(albumId)) return c.json({ error: 'Invalid album ID' }, 400);
    if (!slskdRef.current) return c.json({ error: 'Soulseek is not configured' }, 503);

    const replace = c.req.query('replace') === 'true';

    const body = await c.req
      .json<{
        selected: { username: string; directory: string; files: Array<{ filename: string; size: number }> };
        alternates?: AlternateCandidate[];
      }>()
      .catch(() => null);

    if (!body?.selected?.username || !body.selected.files?.length) {
      return c.json({ error: 'Missing selected candidate' }, 400);
    }

    // Guard 1: an active job means a download for this album is already in flight.
    const activeJob = db
      .query<{ id: number }, [number]>(
        `SELECT id FROM album_jobs WHERE lidarr_album_id = ? AND state = 'active' LIMIT 1`,
      )
      .get(albumId);
    if (activeJob && !replace) {
      return c.json({ error: 'already-downloading', jobId: activeJob.id }, 409);
    }
    if (replace && activeJob) {
      // Supersede every active job for this album so at most one stays active.
      db.run(`UPDATE album_jobs SET state = 'superseded' WHERE lidarr_album_id = ? AND state = 'active'`, [albumId]);
    }

    // Fetch canonical metadata up front — needed for the completeness guard and
    // the recorded job. Best-effort: a Lidarr hiccup must not block the download.
    const [album, tracks] = await Promise.all([
      lidarr.album.get(albumId).catch(() => null),
      lidarr.track.listByAlbum(albumId).catch(() => []),
    ]);
    const artistName = album?.artist?.artistName ?? null;
    const albumTitle = album?.title ?? null;

    // Guard 2: the album is already complete in the library — don't acquire a
    // duplicate edition. Skipped on explicit replace.
    if (!replace && artistName && albumTitle && tracks.length > 0) {
      if (albumAlreadyComplete(db, artistName, albumTitle, tracks.length)) {
        return c.json({ error: 'already-complete' }, 409);
      }
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
      AlbumFallbackService.recordJob(db, {
        lidarrAlbumId: albumId,
        username: body.selected.username,
        directory: body.selected.directory,
        // Artist name lets the fallback fire a fresh per-track slskd search when
        // the recorded alternates can't cover a missing track.
        artistName,
        albumTitle,
        canonicalTracks: tracks.map((t) => t.title),
        // Recovery target: the files the user actually chose, so a folder that
        // downloads in full never triggers a duplicate-dumping fallback wave.
        targetFiles: body.selected.files,
        alternates: body.alternates ?? [],
      });
    } catch (err) {
      log.warn({ albumId, err }, 'Failed to record album job for fallback');
    }

    return c.json({ ok: true, queued: body.selected.files.length }, 201);
  });

  return app;
}

/**
 * True when the library already holds this album (same artist, same
 * edition-stripped title) with at least as many songs as its canonical
 * tracklist. Uses `normalizeForGrouping` so deluxe/remaster editions of an album
 * we already have are treated as "complete" and don't get re-acquired.
 */
function albumAlreadyComplete(
  db: Database,
  artist: string,
  title: string,
  trackCount: number,
): boolean {
  const targetName = normalizeForGrouping(title);
  const rows = db
    .query<{ name: string; song_count: number }, [string]>(
      `SELECT name, song_count FROM library_albums WHERE artist = ? COLLATE NOCASE`,
    )
    .all(artist);
  return rows.some((r) => normalizeForGrouping(r.name) === targetName && r.song_count >= trackCount);
}
