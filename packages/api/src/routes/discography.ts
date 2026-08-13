import { Hono } from 'hono';
import { createLogger } from '@nicotind/core';
import type { Database } from 'bun:sqlite';
import type { AuthEnv } from '../middleware/auth.js';
import { requireAcquirer } from '../middleware/current-user.js';
import type { DiscographyService } from '../services/discography.service.js';
import type { AlbumHuntOrchestrator } from '../services/source-hunter.js';
import { albumIdFor, artistIdFor } from '../services/library-scanner.js';
import { albumAlreadyComplete } from '../services/library-completeness.js';
import { setArtwork, pickAlbumCover, pickArtistImage } from '../services/artwork-store.js';
import { recordAcquiredArtistIdentity } from '../services/artist-identity-store.js';
import { createJob, supersedeActiveJobs } from '../services/acquisition-job-store.js';
import { normalizeTitle, titlesOverlap } from '@nicotind/core';
import type { AddonAlbumCandidate } from '@nicotind/core';
import { join } from 'node:path';
import type { Lidarr } from '@nicotind/lidarr-client';
import type { RemoteAddonPlugin } from '../services/addons/remote-addon-plugin.js';
import { AddonRequestError } from '../services/addons/client.js';
import { mapAddonJob } from '../services/addons/job-poller.js';
import { onDiskTitles } from '../services/library-completeness.js';

const log = createLogger('discography');

/**
 * An addon album candidate in the wire shape the hunt modal renders (the
 * in-process FolderCandidate), plus its candidateRef — the modal passes it
 * back through hunt-download so the addon acquires the user's exact pick.
 */
function wireCandidate(c: AddonAlbumCandidate) {
  return {
    candidateRef: c.candidateRef,
    username: c.username,
    directory: c.directory,
    files: c.files.map((f) => ({ filename: f.filename, size: f.size, bitRate: f.bitRateKbps })),
    matchedTracks: c.matchedTracks,
    totalTracks: c.totalTracks,
    matchPct: c.matchPct,
    format: c.format,
    estimatedSizeMb: c.estimatedSizeMb,
    isLive: c.isLive,
    freeUploadSlots: c.freeUploadSlots ?? 0,
    queueLength: c.queueLength ?? 0,
    uploadSpeed: c.uploadSpeed ?? 0,
  };
}

export interface DiscographyRoutesOptions {
  discography: DiscographyService;
  /**
   * Source-agnostic hunt across the metadata sources (archive.org, Spotify, …).
   * Backs `/hunt/sources` so the modal renders ONE blended candidate list with
   * Soulseek's live two-phase folder candidates. See source-hunter.ts.
   */
  sourceHunt: AlbumHuntOrchestrator;
  lidarr: Lidarr;
  db: Database;
  /** App data dir — used to purge stale canonical-cover cache when artwork changes. */
  dataDir?: string;
  /** Live lookup of the active remote acquisition addon (the only hunt engine since phase 3). */
  getAddon: () => RemoteAddonPlugin | null;
}

export function discographyRoutes({
  discography,
  sourceHunt,
  lidarr,
  db,
  dataDir,
  getAddon,
}: DiscographyRoutesOptions) {
  const app = new Hono<AuthEnv>();
  const coverCacheDir = dataDir ? join(dataDir, 'cover-cache') : undefined;

  // Discography hunt is acquisition — hidden from listeners, gated server-side.
  app.use('*', async (c, next) => {
    requireAcquirer(c);
    await next();
  });

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

      const addon = getAddon();
      if (!addon) return c.json({ error: 'No acquisition addon registered' }, 503);
      const res = await addon.client.albumsSearch({
        artist: artistName,
        album: albumTitle,
        canonicalTracks: tracks.map((t) => ({ title: t.title })),
        skew: body.skewSearch,
      });
      return c.json({
        candidates: res.candidates.map(wireCandidate),
        totalTracks: tracks.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ albumId, err: msg }, 'Album hunt failed');
      return c.json({ error: msg }, 500);
    }
  });

  // POST /api/discography/albums/:lidarrAlbumId/hunt/sources
  // Source-agnostic hunt across the metadata sources (archive.org, Spotify, …):
  // returns ONE blended, ranked `AcquisitionCandidate[]` so the modal can show a
  // single results list (with Soulseek's live two-phase folder candidates) and a
  // single Get action per row. Each source self-gates on its plugin; an all-off
  // set returns an empty list (never an error). Optional body: { artistName?,
  // albumTitle? }. See docs/source-agnostic-acquisition.md.
  app.post('/albums/:lidarrAlbumId/hunt/sources', async (c) => {
    const { lidarrAlbumId } = c.req.param();
    const albumId = Number(lidarrAlbumId);
    if (Number.isNaN(albumId)) return c.json({ error: 'Invalid album ID' }, 400);

    type HuntBody = { artistName?: string; albumTitle?: string };
    const body = await c.req.json<HuntBody>().catch(() => ({}) as HuntBody);

    try {
      const album = await lidarr.album.get(albumId);
      const artistName = body.artistName ?? album.artist?.artistName ?? '';
      const albumTitle = body.albumTitle ?? album.title;
      const candidates = await sourceHunt.hunt(artistName, albumTitle);
      return c.json({ candidates, sources: sourceHunt.enabledSourceIds() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ albumId, err: msg }, 'Source hunt failed');
      // Degrade to an empty blend rather than failing the modal — Soulseek
      // candidates load independently.
      return c.json({ candidates: [], sources: sourceHunt.enabledSourceIds() });
    }
  });

  // POST /api/discography/albums/:lidarrAlbumId/hunt-tracks
  // §C1/§F2 fallback for the album-hunt dead-end: when no whole-album folder
  // exists, hunt each canonical track individually and enqueue the best match.
  // Resolves the tracklist from Lidarr, then runs the per-track hunter.
  app.post('/albums/:lidarrAlbumId/hunt-tracks', async (c) => {
    const { lidarrAlbumId } = c.req.param();
    const albumId = Number(lidarrAlbumId);
    if (Number.isNaN(albumId)) return c.json({ error: 'Invalid album ID' }, 400);
    const trackAddon = getAddon();
    if (!trackAddon) return c.json({ error: 'No acquisition addon registered' }, 503);

    const body = await c.req
      .json<{ artistName?: string }>()
      .catch(() => ({}) as { artistName?: string });

    try {
      const [album, tracks] = await Promise.all([
        lidarr.album.get(albumId),
        lidarr.track.listByAlbum(albumId),
      ]);
      const artistName = body.artistName ?? album.artist?.artistName ?? '';
      const titles = tracks.map((t) => t.title).filter((t): t is string => !!t?.trim());
      if (titles.length === 0) return c.json({ error: 'No tracks to hunt' }, 404);

      if (trackAddon) {
        // The per-track hunt runs addon-side; the response keeps the
        // TrackHuntResult shape the modal renders. A confident zero-result is
        // an all-miss result, not an error (matching the in-process path).
        let job;
        try {
          job = await trackAddon.client.createJob({
            intent: 'tracks',
            artist: artistName,
            album: album.title,
            titles,
          });
        } catch (err) {
          if (err instanceof AddonRequestError && err.status === 400) {
            return c.json({ requested: titles.length, enqueued: 0, misses: titles, downloads: [] });
          }
          throw err;
        }
        const found = new Set(job.items.map((i) => i.title));
        try {
          const coreJobId = createJob(db, {
            kind: 'track-search',
            method: trackAddon.manifest.id,
            artistName: artistName || null,
            albumTitle: album.title ?? null,
            lidarrAlbumId: albumId,
            releaseMbid: album.foreignAlbumId ?? null,
            artistMbid: album.artist?.foreignArtistId ?? null,
            genres: album.genres?.length ? album.genres : (album.artist?.genres ?? null),
            year: album.releaseDate ? new Date(album.releaseDate).getUTCFullYear() : null,
            canonicalTracks: titles,
            sourceRef: `addon:${trackAddon.manifest.id}:${job.id}`,
            files: [],
          });
          mapAddonJob(db, trackAddon.manifest.id, job.id, coreJobId);
        } catch (err) {
          log.warn({ albumId, err }, 'Failed to record track-search acquisition job (addon)');
        }
        return c.json({
          requested: titles.length,
          enqueued: job.items.length,
          misses: titles.filter((t) => !found.has(t)),
          downloads: job.items.map((i) => ({
            username: i.username,
            filename: i.filename,
            size: i.size,
            title: i.title ?? '',
            bitRate: i.bitRateKbps,
          })),
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ albumId, err: msg }, 'Track hunt failed');
      return c.json({ error: msg }, 500);
    }
  });

  // POST /api/discography/albums/:lidarrAlbumId/hunt/base
  // Phase-1 of the two-phase hunt: fires only the base queries and returns
  // whether skew variants are needed. Used by the hunt modal to animate
  // per-query progress (base rows → searching → done, then skew rows if needed).
  app.post('/albums/:lidarrAlbumId/hunt/base', async (c) => {
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

      const addon = getAddon();
      if (!addon) return c.json({ error: 'No acquisition addon registered' }, 503);
      // The addon runs its own base→skew policy in one call, so the modal's
      // two-phase animation collapses to a single completed phase. Hunt-match
      // feedback capture is dormant until the protocol's feedback capability
      // lands (the raw responses live addon-side).
      const res = await addon.client.albumsSearch({
        artist: artistName,
        album: albumTitle,
        canonicalTracks: tracks.map((t) => ({ title: t.title })),
        skew: body.skewSearch,
      });
      return c.json({
        candidates: res.candidates.map(wireCandidate),
        totalTracks: tracks.length,
        skewNeeded: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ albumId, err: msg }, 'Album hunt (base phase) failed');
      return c.json({ error: msg }, 500);
    }
  });

  // POST /api/discography/albums/:lidarrAlbumId/hunt/skew
  // Phase-2 of the two-phase hunt: fires skew-variant queries and returns their
  // candidates. The frontend merges these with the base-phase candidates.
  app.post('/albums/:lidarrAlbumId/hunt/skew', async (c) => {
    const { lidarrAlbumId } = c.req.param();
    const albumId = Number(lidarrAlbumId);
    if (Number.isNaN(albumId)) return c.json({ error: 'Invalid album ID' }, 400);

    type HuntBody = { artistName?: string; albumTitle?: string };
    const body = await c.req.json<HuntBody>().catch(() => ({}) as HuntBody);

    try {
      const [album, tracks] = await Promise.all([
        lidarr.album.get(albumId),
        lidarr.track.listByAlbum(albumId),
      ]);

      const artistName = body.artistName ?? album.artist?.artistName ?? '';
      const albumTitle = body.albumTitle ?? album.title;

      const addon = getAddon?.() ?? null;
      if (!addon) return c.json({ error: 'No acquisition addon registered' }, 503);
      const res = await addon.client.albumsSearch({
        artist: artistName,
        album: albumTitle,
        canonicalTracks: tracks.map((t) => ({ title: t.title })),
        skew: true,
      });
      return c.json({ candidates: res.candidates.map(wireCandidate) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ albumId, err: msg }, 'Album hunt (skew phase) failed');
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
    const addon = getAddon();
    if (!addon) return c.json({ error: 'No acquisition addon registered' }, 503);

    const replace = c.req.query('replace') === 'true';

    const body = await c.req
      .json<{
        selected: {
          username: string;
          directory: string;
          files: Array<{ filename: string; size: number }>;
          /** Addon path: the hunt candidate token the addon resolves the pick by. */
          candidateRef?: string;
        };
        /** Unused since phase 3 — the addon's cached hunt siblings are the alternates. */
        alternates?: Array<{
          username: string;
          directory: string;
          files: Array<{ filename: string; size: number }>;
        }>;
        // The local album the user is completing, already resolved by the artist
        // page. Lets the completeness filter match on-disk tracks precisely even
        // when the canonical Lidarr artist/title diverges from the local tags.
        localAlbumId?: string;
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
      db.run(
        `UPDATE album_jobs SET state = 'superseded' WHERE lidarr_album_id = ? AND state = 'active'`,
        [albumId],
      );
      supersedeActiveJobs(db, { lidarrAlbumId: albumId });
    }

    // Fetch canonical metadata up front — needed for the completeness guard and
    // the recorded job. Best-effort: a Lidarr hiccup must not block the download.
    const [album, tracks] = await Promise.all([
      lidarr.album.get(albumId).catch(() => null),
      lidarr.track.listByAlbum(albumId).catch(() => []),
    ]);
    const artistName = album?.artist?.artistName ?? null;
    const albumTitle = album?.title ?? null;

    // Persist canonical artwork keyed on the same ids the scanner will mint, so
    // the album/artist render the exact image the hunt tool showed (rather than
    // the rip's embedded art) the moment the download lands. Best-effort.
    if (album && artistName && albumTitle) {
      try {
        const albumCover = pickAlbumCover(album.images);
        if (albumCover) {
          setArtwork(db, albumIdFor(artistName, albumTitle), 'album', albumCover, coverCacheDir);
        }
        const artistImage = pickArtistImage(album.artist?.images);
        if (artistImage) {
          setArtwork(db, artistIdFor(artistName), 'artist', artistImage, coverCacheDir);
        }
      } catch (err) {
        log.warn({ albumId, err }, 'Failed to persist canonical artwork');
      }
      // Same rationale as the artwork: persist the canonical artist identity
      // (one-act decision + MBID) so the scan that lands this download already
      // knows the artist — no waiting on the artist-identity background task.
      try {
        recordAcquiredArtistIdentity(db, {
          artistKey: artistIdFor(artistName),
          artistName,
          mbid: album.artist?.foreignArtistId ?? null,
        });
      } catch (err) {
        log.warn({ albumId, err }, 'Failed to persist acquired artist identity');
      }
    }

    // Guard 2: the album is already complete in the library — don't acquire a
    // duplicate edition. Skipped on explicit replace.
    if (!replace && artistName && albumTitle && tracks.length > 0) {
      if (albumAlreadyComplete(db, artistName, albumTitle, tracks.length)) {
        return c.json({ error: 'already-complete' }, 409);
      }
    }

    // Addon cutover: the user's exact pick (candidateRef) is acquired
    // addon-side — hunt scoping, enqueue and the per-peer fallback (alternates
    // come from the addon's own cached hunt siblings, so the web-sent
    // `alternates` are unused here). Library knowledge stays core-side:
    // wantedTracks is the canonical titles not already on disk.
    if (addon) {
      if (!body.selected.candidateRef) {
        return c.json({ error: 'Selection expired — run the search again' }, 400);
      }
      const titles = tracks.map((t) => t.title);
      const onDisk =
        artistName && albumTitle ? onDiskTitles(db, artistName, albumTitle, body.localAlbumId) : [];
      const wanted = titles.filter((t) => !onDisk.some((d) => titlesOverlap(d, normalizeTitle(t))));
      if (titles.length > 0 && wanted.length === 0) {
        return c.json({ ok: true, queued: 0, alreadyComplete: true }, 200);
      }

      const createAddonSide = () =>
        addon.client.createJob({
          intent: 'album',
          artist: artistName ?? undefined,
          album: albumTitle ?? undefined,
          canonicalTracks: titles.map((title) => ({ title })),
          wantedTracks: wanted.map((title) => ({ title })),
          candidateRef: body.selected.candidateRef,
        });

      let addonJob;
      try {
        addonJob = await createAddonSide();
      } catch (err) {
        if (err instanceof AddonRequestError && err.status === 409) {
          if (!replace) return c.json({ error: 'already-downloading' }, 409);
          // Admin re-hunt: supersede the addon's active job, then retry.
          try {
            const active = (await addon.client.listJobs()).find(
              (j) =>
                j.intent === 'album' &&
                j.state === 'active' &&
                j.artist === artistName &&
                j.album === albumTitle,
            );
            if (active) {
              await addon.client.cancelJob(active.id).catch(() => {});
              await addon.client.deleteJob(active.id).catch(() => {});
            }
            supersedeActiveJobs(db, { lidarrAlbumId: albumId });
            addonJob = await createAddonSide();
          } catch (retryErr) {
            const msg = retryErr instanceof Error ? retryErr.message : 'replace failed';
            return c.json({ error: msg }, 502);
          }
        } else if (err instanceof AddonRequestError && err.status === 400) {
          return c.json({ error: err.message }, 400);
        } else {
          return c.json(
            { error: `Download failed for user "${body.selected.username}" — they may be offline` },
            502,
          );
        }
      }

      try {
        const coreJobId = createJob(db, {
          kind: 'album-hunt',
          method: addon.manifest.id,
          artistName,
          albumTitle,
          lidarrAlbumId: albumId,
          releaseMbid: album?.foreignAlbumId ?? null,
          artistMbid: album?.artist?.foreignArtistId ?? null,
          genres: album?.genres?.length ? album.genres : (album?.artist?.genres ?? null),
          year: album?.releaseDate ? new Date(album.releaseDate).getUTCFullYear() : null,
          canonicalTracks: titles,
          sourceRef: `addon:${addon.manifest.id}:${addonJob.id}`,
          files: [],
        });
        mapAddonJob(db, addon.manifest.id, addonJob.id, coreJobId);
      } catch (err) {
        log.warn({ albumId, err }, 'Failed to record acquisition job (addon)');
      }

      return c.json({ ok: true, queued: addonJob.items.length }, 201);
    }

    // (unreachable — the addon branch above always returns)
  });

  return app;
}
