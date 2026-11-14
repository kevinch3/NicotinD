import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import type { ProviderRegistry } from '../services/provider-registry.js';
import { RemoteAddonPlugin } from '../services/addons/remote-addon-plugin.js';
import type { PluginRegistry } from '../services/plugins/registry.js';
import { createLogger, folderAlbumIdentity, type DownloadReceipt } from '@nicotind/core';
import { getDatabase } from '../db.js';
import { getCurrentUser, requireAcquirer } from '../middleware/current-user.js';
import { ForbiddenError, asRole, canCurate } from '@nicotind/core';
import {
  cancelUnownedJob,
  pendingIngestCount,
  requestJobCancel,
  createJob,
  jobPartialContents,
  listJobFeed,
  markPartialDiscarded,
  recomputeStage,
  resolveJobAlbumId,
  findActiveAlbumJob,
  holdAlbum,
  supersedeActiveJobs,
  addonJobIdsOf,
} from '../services/acquisition-job-store.js';
import {
  parseAddonRef,
  resolveResourceTarget,
  searchAlternates,
  switchToPeer,
} from '../services/job-resource.js';
import { mapAddonJob } from '../services/addons/job-poller.js';
import { AddonTimeoutError } from '../services/addons/client.js';
import { INTERACTIVE_HUNT_TIMEOUT_MS } from '../middleware/idle-budget.js';
import { deleteSongs } from '../services/library-deletion.js';
import { errorHandler } from '../middleware/error-handler.js';
import type { TrackGetService } from '../services/track-get.service.js';
import { trackGetRoutes } from './track-get.js';
import { recordAudit } from '../services/audit-log.js';
import { acquireAlbum } from '../services/album-acquire.js';
import type { Lidarr } from '../lidarr/index.js';
import { attachSongArtists } from '../services/artist-attach.js';
import { SONG_SELECT, rowToSong, type SongRow } from './library.js';
import type { ShareRescanScheduler } from '../services/share-rescan-scheduler.js';

const log = createLogger('downloads');

const DownloadFileSchema = z.object({
  filename: z.string(),
  size: z.number(),
});

const EnqueueDownloadRequestSchema = z.object({
  username: z.string().min(1).openapi({ example: 'slsk_user' }),
  files: z.array(DownloadFileSchema).min(1),
  /** The album this grab is, when the client knows (#1539). Wins over the
   *  folder-name guess for both the duplicate guard and the job's name. */
  album: z
    .object({
      artist: z.string().min(1),
      title: z.string().min(1),
      lidarrAlbumId: z.number().int().nullable().optional(),
    })
    .optional(),
  /** Supersede a live acquisition of the same album instead of refusing. */
  replace: z.boolean().optional(),
});

/** Below this many files from one folder a grab is a track or two, not an album. */
const ALBUM_GRAB_MIN_FILES = 3;

function directoryOf(filename: string): string {
  const parts = filename.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(0, -1).join('/');
}

const AlreadyDownloadingSchema = z
  .object({
    error: z.literal('already-downloading'),
    // Absent when another request holds the album and has no job row yet.
    jobId: z.string().optional(),
  })
  .openapi('AlreadyDownloading');

const DownloadResponseSchema = z
  .object({
    ok: z.boolean(),
    queued: z.number(),
    /** The acquisition job wrapping this grab, or null when recording it failed
     *  (best-effort). The web keys its "get, then hear it" intent on it (#1294). */
    jobId: z.string().nullable(),
  })
  .openapi('DownloadResponse');

const ErrorSchema = z
  .object({
    error: z.string(),
  })
  .openapi('Error');

export interface DownloadDiscardDeps {
  musicDir?: string;
  shareRescan: ShareRescanScheduler;
}

/** What re-hunting a failed album needs: the same inputs the unattended lanes use. */
export interface AlbumRetryDeps {
  lidarr: Lidarr | null;
  getAddon: () => RemoteAddonPlugin | null;
  minMatchPct: number;
}

const RETRYABLE_ALBUM_KINDS = new Set(['album-hunt', 'auto-acquire']);

export function downloadRoutes(
  registry: ProviderRegistry,
  pluginRegistry?: PluginRegistry,
  discardDeps?: DownloadDiscardDeps,
  albumRetry?: AlbumRetryDeps,
  trackGet?: TrackGetService,
) {
  const app = new OpenAPIHono<AuthEnv>();
  // Self-contained error mapping (the download-review.ts pattern): the
  // discard-partial gate's ForbiddenError must map to 403 even when this
  // router is mounted bare (route tests) without the app-level onError.
  app.onError(errorHandler);

  // The Downloads feed is acquisition — hidden from listeners, gated server-side.
  app.use('*', async (c, next) => {
    requireAcquirer(c);
    await next();
  });

  // POST /track — the one-click track Get (#1885).
  if (trackGet) app.route('/', trackGetRoutes(trackGet));

  // Enqueue downloads — via network provider
  app.openapi(
    createRoute({
      method: 'post',
      path: '/',
      request: {
        body: {
          content: {
            'application/json': {
              schema: EnqueueDownloadRequestSchema,
            },
          },
        },
      },
      responses: {
        201: {
          content: {
            'application/json': {
              schema: DownloadResponseSchema,
            },
          },
          description: 'Download enqueued successfully',
        },
        400: {
          content: {
            'application/json': {
              schema: ErrorSchema,
            },
          },
          description: 'Bad request',
        },
        409: {
          content: {
            'application/json': {
              schema: AlreadyDownloadingSchema,
            },
          },
          description: 'The same album is already downloading (any lane)',
        },
        502: {
          content: {
            'application/json': {
              schema: ErrorSchema,
            },
          },
          description: 'Bad Gateway (Provider unreachable)',
        },
        503: {
          content: {
            'application/json': {
              schema: ErrorSchema,
            },
          },
          description: 'Service Unavailable (Soulseek not configured)',
        },
      },
    }),
    async (c) => {
      const { username, files, album, replace } = c.req.valid('json');

      const networkProviders = registry.getByType('network');
      const provider = networkProviders[0];

      if (!provider?.download) {
        return c.json({ error: 'No download provider available' }, 503);
      }

      // One album = one download across every lane (#1539): an album-shaped grab
      // is refused while the same album is live — a catalog Get, another peer's
      // folder — unless the caller asked to replace it. The client's own naming
      // wins; otherwise the folder is read ("Artist - Album [2015]", or
      // parent/leaf). Generic containers name nothing and guard nothing.
      const dir = directoryOf(files[0]!.filename);
      const oneFolder = files.every((f) => directoryOf(f.filename) === dir);
      const guessed = oneFolder ? folderAlbumIdentity(dir) : { artist: null, title: null };
      const identity = album ?? (guessed.artist && guessed.title ? guessed : null);
      const albumShaped =
        album !== undefined || (oneFolder && files.length >= ALBUM_GRAB_MIN_FILES);
      let release: (() => void) | null = null;
      if (identity?.artist && identity.title && albumShaped) {
        const target = {
          lidarrAlbumId: album?.lidarrAlbumId ?? null,
          artist: identity.artist,
          title: identity.title,
        };
        const db = getDatabase();
        if (replace) supersedeActiveJobs(db, target);
        else {
          const active = findActiveAlbumJob(db, target);
          if (active)
            return c.json({ error: 'already-downloading' as const, jobId: active.id }, 409);
        }
        // Held from here until the job row exists: the row is the guard's evidence.
        release = holdAlbum(target);
        if (!release) return c.json({ error: 'already-downloading' as const }, 409);
      }

      try {
        let receipt: DownloadReceipt | void;
        try {
          receipt = await provider.download(username, files);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('request failed')) {
            return c.json(
              {
                error: `Download failed for user "${username}" — they may be offline or rejecting transfers`,
              },
              502,
            );
          }
          return c.json({ error: 'Soulseek is temporarily unreachable' }, 503);
        }

        // Wrap even raw folder-browser grabs in a lightweight acquisition job so
        // every transfer belongs to a job (uniform feed, stored linkage). No
        // canonical metadata here — artist/album are best-effort display hints
        // parsed from the peer's folder segments. Best-effort: must never fail
        // the enqueue that already succeeded.
        let jobId: string | null = null;
        try {
          // Display hints, from the client's album or the folder guess above. A
          // generic segment ("complete", "FLAC") stores NULL, not the junk: NULL
          // self-heals via the poller's COALESCE backfill from the addon's
          // metadata; a junk hint blocks that backfill forever (#674).
          const db = getDatabase();
          // When an addon runs the grab, this row must be THE mirror of its job:
          // `source_ref` is what `/jobs/:id/cancel` resolves the owning addon
          // from, and the jobmap is what stops the poller minting a twin row on
          // its next tick (the twin got the files and the Remove button; this
          // row sat "Downloading 0 of N" forever — the Kaleo card).
          const addonJobId = receipt?.addonJobId;
          const coreJobId = createJob(db, {
            kind: 'direct',
            // The provider's name is the source id (the addon's manifest id).
            method: provider.name,
            userId: getCurrentUser(c).sub,
            artistName: album?.artist ?? guessed.artist,
            albumTitle: album?.title ?? guessed.title,
            albumFromFolder: !album && guessed.title !== null,
            lidarrAlbumId: album?.lidarrAlbumId ?? null,
            sourceRef: addonJobId ? `addon:${provider.name}:${addonJobId}` : username,
            username,
            files,
          });
          if (addonJobId) mapAddonJob(db, provider.name, addonJobId, coreJobId);
          jobId = coreJobId;
        } catch (err) {
          log.warn({ username, err }, 'Failed to record acquisition job for direct download');
        }
        return c.json({ ok: true, queued: files.length, jobId }, 201);
      } finally {
        release?.();
      }
    },
  );

  // Unified acquisition-job feed: one row per job (any method), newest first,
  // with per-state item progress and a deep-linkable albumId. Read model for
  // the Downloads page's job view.
  app.get('/jobs', (c) => {
    const db = getDatabase();
    const jobs = listJobFeed(db).map((job) => ({
      ...job,
      // The feed already knows where a job's files landed; only a job with no
      // single destination (nothing landed yet, or several albums) needs the
      // dominant-album resolve and its extra join.
      albumId:
        job.destinationAlbums.length === 1
          ? job.destinationAlbums[0]!.albumId
          : resolveJobAlbumId(db, job.id, job.artistName, job.albumTitle),
    }));
    return c.json(jobs, 200);
  });

  /**
   * The songs one job landed, in album order (#1294, docs/get-then-hear.md) —
   * what the device that pressed Get puts in its queue once the job is done.
   * Keyed on the items' own `song_id`, so a job that shares an album with
   * another never hands back the other job's tracks. `state` rides along so a
   * caller can tell "not landed yet" from "landed nothing".
   */
  app.get('/jobs/:id/songs', (c) => {
    const db = getDatabase();
    const id = c.req.param('id');
    const job = db
      .query<{ state: string }, [string]>(`SELECT state FROM acquisition_jobs WHERE id = ?`)
      .get(id);
    if (!job) return c.json({ error: 'Job not found', code: 'JOB_NOT_FOUND' }, 404);
    const songs = db
      .query<SongRow, [string]>(
        `${SONG_SELECT}
          WHERE s.hidden = 0
            AND s.id IN (SELECT song_id FROM acquisition_job_items
                          WHERE job_id = ? AND song_id IS NOT NULL)
          ORDER BY a.name COLLATE NOCASE ASC, s.album_id ASC, COALESCE(s.disc, 1) ASC,
                   s.track ASC NULLS LAST, s.title COLLATE NOCASE ASC`,
      )
      .all(id)
      .map(rowToSong);
    attachSongArtists(db, songs);
    return c.json({ jobId: id, state: job.state, songs }, 200);
  });

  /**
   * Job-level actions for addon-backed jobs (acquisition addon protocol
   * phase 2): the per-transfer routes below key on `username::filename`, which
   * addon items don't have — their transfers live addon-side. Resolves the
   * owning addon from the job's method and proxies cancel/delete; the poller's
   * next tick mirrors the resulting item states back into the feed.
   */
  app.post('/jobs/:id/cancel', async (c) => {
    const db = getDatabase();
    const job = db
      .query<{ id: string; method: string; source_ref: string | null }, [string]>(
        `SELECT id, method, source_ref FROM acquisition_jobs WHERE id = ?`,
      )
      .get(c.req.param('id'));
    if (!job) return c.json({ error: 'Job not found' }, 404);
    const ref = parseAddonRef(job.source_ref);
    if (!ref || ref.addonId !== job.method) {
      // No addon owns this row (a legacy peer-ref grab, or a direct grab made
      // before the route linked them), so there is nothing to proxy to — but
      // the row is core's, and refusing here is what left "Cancel all"
      // powerless against a stuck card. Close it honestly instead.
      log.info({ jobId: job.id, method: job.method }, 'closing a non-addon job core-side');
      // A Get still looking for its source: marked, so the feed says cancelled, not failed.
      if (job.source_ref === null) requestJobCancel(db, job.id);
      cancelUnownedJob(db, job.id);
      return c.json({ ok: true });
    }
    // Durable intent FIRST (#806): the marker is what the feed renders as
    // "Cancelling…", what stops the poller re-pinning the row, and what its
    // grace valve closes if the addon never acts — so every path below returns
    // 200 once it is stamped. A repeat request is a no-op that never
    // re-notifies the addon (the old 502-on-error path muted the click and
    // left re-clicks re-firing forever).
    const first = requestJobCancel(db, job.id);
    if (!first) return c.json({ ok: true, pending: true });
    const addon = pluginRegistry?.get(ref.addonId);
    if (!(addon instanceof RemoteAddonPlugin)) {
      return c.json({ ok: true, addonNotified: false });
    }
    // Every peer still working for this card, not just the first (#1878).
    let notified = true;
    for (const addonJobId of addonJobIdsOf(db, job.id, ref.addonJobId, { live: true })) {
      try {
        await addon.client.cancelJob(addonJobId);
      } catch (err) {
        log.warn(
          { jobId: job.id, addonJobId, err },
          'addon cancel failed; grace valve will close the job',
        );
        notified = false;
      }
    }
    return c.json(notified ? { ok: true } : { ok: true, addonNotified: false });
  });

  /**
   * Discard the partial tracks a job landed (#810): the decision point a
   * cancelled download's owner was missing — with the review hold armed the
   * partial sat as an opaque "Processing" card, and a plain acquirer had no
   * legal path to remove it at all (review discard is curator-gated).
   * Job-scoped by design: `deleteSongs` via per-song `deleteOne`, never the
   * whole destination album — a `complete_album` job only added tracks to it.
   * Gate: the job's own user (removing your own aborted download is not
   * curation — docs/roles.md), or a curator; a NULL-owner row (system lanes,
   * pre-#810 rows) stays curator-only.
   */
  app.post('/jobs/:id/discard-partial', async (c) => {
    const db = getDatabase();
    const user = getCurrentUser(c);
    const job = db
      .query<{ id: string; user_id: string | null }, [string]>(
        `SELECT id, user_id FROM acquisition_jobs WHERE id = ?`,
      )
      .get(c.req.param('id'));
    if (!job) return c.json({ error: 'Job not found' }, 404);
    const isOwner = job.user_id != null && job.user_id === user.sub;
    if (!isOwner && !canCurate(asRole(user.role))) {
      throw new ForbiddenError("Requires curator role, or the job's own user");
    }
    if (!discardDeps) return c.json({ error: 'Discard is not available' }, 503);

    // Marker FIRST: a fileReady item mid-flight on the poller must not land
    // after (or while) its siblings are being deleted.
    markPartialDiscarded(db, job.id);
    const { songIds, orphanRelPaths } = jobPartialContents(db, job.id);
    const result = await deleteSongs(db, songIds, discardDeps, orphanRelPaths);
    recomputeStage(db, job.id);
    recordAudit(db, user, 'download.discard_partial', {
      targetKind: 'acquisition_job',
      targetId: job.id,
      detail: `deleted ${result.deletedCount} track(s), ${result.failed.length} failed`,
    });
    return c.json({ ok: true, deletedCount: result.deletedCount, failed: result.failed });
  });

  /**
   * Re-source a stuck download from another peer (#1065).
   *
   * A hunt commits to one peer's folder. When that peer never uploads, the card
   * sits at "0 of 14 · PENDING" and the only verbs are cancel and delete — so
   * the fix has always been to throw the job away and re-download tracks that
   * already landed. These two routes let the card keep its identity and hand
   * only the missing titles to someone else.
   *
   * Two calls, not one, because finding another peer means re-running the hunt
   * (core keeps no candidates: `candidateRef` is addon-side and short-lived)
   * and that takes tens of seconds. A single blind route would be a button that
   * spins for a minute and then reports a decision the user never saw.
   *
   * → docs/download-pipeline.md "Re-sourcing from another peer"
   */

  /**
   * The job, its addon and its owner — or the response that says why this card
   * cannot be re-sourced. Shared by both routes so the search can never offer
   * peers for a job the commit would then refuse.
   */
  function resourceableJob(c: Context<AuthEnv>, db: ReturnType<typeof getDatabase>) {
    const id = c.req.param('id');
    const owner = id
      ? db
          .query<{ user_id: string | null }, [string]>(
            `SELECT user_id FROM acquisition_jobs WHERE id = ?`,
          )
          .get(id)
      : null;
    if (!owner) return { error: c.json({ error: 'Job not found' }, 404) } as const;
    // Same gate as discard-partial: re-sourcing your own download is not
    // curation (docs/roles.md), and a NULL-owner row stays curator-only.
    const user = getCurrentUser(c);
    const isOwner = owner.user_id != null && owner.user_id === user.sub;
    if (!isOwner && !canCurate(asRole(user.role))) {
      throw new ForbiddenError("Requires curator role, or the job's own user");
    }
    const target = resolveResourceTarget(db, (addonId) => pluginRegistry?.get(addonId), id!);
    if ('error' in target) {
      return { error: c.json({ error: target.error }, target.status) } as const;
    }
    return { target, user } as const;
  }

  /**
   * Which other peers have the tracks this job is stuck on.
   * → services/job-resource.ts `searchAlternates`.
   */
  app.post('/jobs/:id/resource/search', async (c) => {
    const db = getDatabase();
    const found = resourceableJob(c, db);
    if ('error' in found) return found.error;

    const body = await c.req
      .json<{ require?: string[] }>()
      .catch(() => ({}) as { require?: string[] });
    let res;
    try {
      res = await searchAlternates(db, found.target, {
        require: body.require,
        timeoutMs: INTERACTIVE_HUNT_TIMEOUT_MS,
        lane: 'resource',
      });
    } catch (err) {
      if (err instanceof AddonTimeoutError) {
        return c.json({ error: 'The source did not finish searching in time.' }, 504);
      }
      throw err;
    }
    if (!res) return c.json({ error: 'Nothing on this download is still pending' }, 400);
    return c.json(res);
  });

  /**
   * Hand the named titles to the chosen peer, on THIS card — the download the
   * user started is still the download they are watching.
   * → services/job-resource.ts `switchToPeer`.
   */
  app.post('/jobs/:id/resource', async (c) => {
    const db = getDatabase();
    const found = resourceableJob(c, db);
    if ('error' in found) return found.error;
    const { target, user } = found;

    const body = await c.req
      .json<{ candidateRef?: string; titles?: string[] }>()
      .catch(() => ({}) as { candidateRef?: string; titles?: string[] });
    if (!body.candidateRef) return c.json({ error: 'Pick a peer first' }, 400);

    const result = await switchToPeer(db, target, body.candidateRef, body.titles);
    switch (result.status) {
      case 'nothing-pending':
        return c.json({ error: 'Nothing on this download is still pending' }, 400);
      // Only an expired selection is fixed by searching again, and telling
      // someone to re-run a 45 s hunt against a source that is refusing the
      // job is worse than saying nothing.
      case 'conflict':
        return c.json(
          {
            error: 'The source is still holding this album. Give it a moment and try again.',
            code: 'resource_conflict',
          },
          409,
        );
      case 'expired':
        return c.json(
          { error: 'Selection expired — run the search again', code: 'resource_expired' },
          400,
        );
    }
    recordAudit(db, user, 'download.resource', {
      targetKind: 'acquisition_job',
      targetId: target.job.id,
      detail: `re-sourced ${result.titles.length} track(s) to a new peer (addon job ${result.addonJobId})`,
    });
    return c.json({ ok: true, resourced: result.titles.length, addonJobId: result.addonJobId });
  });

  /**
   * Drop a job's row and its addon half. The feed row is core-owned and always
   * deletable (issue #533 — legacy peer-ref rows and url mirrors used to 400 here,
   * pointing at per-transfer routes that no longer exist, so Remove silently
   * no-opped). The addon half is best-effort and only applies when the ref actually
   * names one. Reports what happened to the addon job, for the audit trail.
   */
  async function removeJob(
    db: ReturnType<typeof getDatabase>,
    job: { id: string; method: string; source_ref: string | null },
  ): Promise<string> {
    const ref = parseAddonRef(job.source_ref);
    let released = 'no addon job';
    if (ref && ref.addonId === job.method) {
      const addon = pluginRegistry?.get(ref.addonId);
      released = `addon ${ref.addonId} unavailable, addon job ${ref.addonJobId} not released`;
      if (addon instanceof RemoteAddonPlugin) {
        // Every addon job the card ever had, not only `source_ref`'s first one:
        // a re-sourced card's replacement peer holds files too (#1878).
        const addonJobIds = addonJobIdsOf(db, job.id, ref.addonJobId, { live: false });
        // Releasing the job makes the addon delete its downloaded files
        // (NicotinD#1052), and the rows below are gone in this same request, so
        // the stranded sweep could never recover them. Discarding is exactly
        // what Remove means, so this is right — but say so out loud, because
        // any still-landing bytes die here and nowhere else records it.
        const pending = pendingIngestCount(db, job.id);
        if (pending > 0) {
          log.info(
            { jobId: job.id, addonJobIds, pending },
            'remove: discarding files that had not landed yet',
          );
        }
        const outcomes: string[] = [];
        for (const addonJobId of addonJobIds) {
          await addon.client.cancelJob(addonJobId).catch(() => {});
          outcomes.push(
            await addon.client.deleteJob(addonJobId).then(
              () => `released addon job ${ref.addonId}:${addonJobId}`,
              (err: unknown) =>
                `addon delete of ${ref.addonId}:${addonJobId} failed (best-effort): ${String(err)}`,
            ),
          );
        }
        released = outcomes.join('; ');
      }
    }
    db.run(`DELETE FROM acquisition_job_items WHERE job_id = ?`, [job.id]);
    db.run(`DELETE FROM acquisition_jobs WHERE id = ?`, [job.id]);
    return released;
  }

  app.delete('/jobs/:id', async (c) => {
    const db = getDatabase();
    const job = db
      .query<{ id: string; method: string; source_ref: string | null }, [string]>(
        `SELECT id, method, source_ref FROM acquisition_jobs WHERE id = ?`,
      )
      .get(c.req.param('id'));
    if (!job) return c.json({ error: 'Job not found' }, 404);
    const released = await removeJob(db, job);
    recordAudit(db, getCurrentUser(c), 'download.remove', {
      targetKind: 'acquisition_job',
      targetId: job.id,
      detail: released,
    });
    return c.json({ ok: true });
  });

  /**
   * Retry a failed or cancelled album (#1511). The original `candidateRef` expired
   * with the addon's hunt cache, so this hunts again by Lidarr album id, the path
   * auto-acquire takes, under the same unattended match bar. The new job replaces
   * the failed card only once it exists, so a hunt that finds nothing leaves the
   * card and its reason where they were.
   */
  app.post('/jobs/:id/retry', async (c) => {
    const db = getDatabase();
    const job = db
      .query<
        {
          id: string;
          kind: string;
          state: string;
          method: string;
          source_ref: string | null;
          artist_name: string | null;
          album_title: string | null;
          lidarr_album_id: number | null;
          artist_mbid: string | null;
        },
        [string]
      >(
        `SELECT id, kind, state, method, source_ref, artist_name, album_title, lidarr_album_id,
                artist_mbid
           FROM acquisition_jobs WHERE id = ?`,
      )
      .get(c.req.param('id'));
    if (!job) return c.json({ error: 'Job not found' }, 404);
    if (
      !RETRYABLE_ALBUM_KINDS.has(job.kind) ||
      job.lidarr_album_id === null ||
      !job.artist_name ||
      !job.album_title
    ) {
      return c.json({ error: 'This download has no album to hunt again' }, 400);
    }
    if (job.state !== 'failed') {
      return c.json({ error: 'Only a failed download can be retried' }, 409);
    }
    if (!albumRetry?.lidarr) return c.json({ error: 'Lidarr not configured' }, 503);

    const user = getCurrentUser(c);
    const { outcome, detail } = await acquireAlbum(
      { db, lidarr: albumRetry.lidarr, getAddon: albumRetry.getAddon },
      {
        lidarrAlbumId: job.lidarr_album_id,
        artistName: job.artist_name,
        albumTitle: job.album_title,
        minMatchPct: albumRetry.minMatchPct,
        artistMbid: job.artist_mbid,
        userId: user.sub,
        retry: true,
        huntTimeoutMs: INTERACTIVE_HUNT_TIMEOUT_MS,
        lane: 'retry',
      },
    );
    recordAudit(db, user, 'album.acquire', {
      targetKind: 'acquisition_job',
      targetId: job.id,
      detail: `retry outcome=${outcome} lidarrAlbumId=${job.lidarr_album_id}${detail ? ` detail=${detail}` : ''}`,
    });
    switch (outcome) {
      case 'enqueued':
        await removeJob(db, job);
        return c.json({ outcome }, 201);
      case 'in-flight':
        return c.json({ error: 'already-downloading' as const }, 409);
      case 'already-complete':
      case 'no-candidate':
        return c.json({ outcome, detail });
      case 'slskd-unavailable':
        return c.json({ error: detail ?? 'The source is unavailable' }, 503);
      default:
        return c.json({ error: detail ?? 'The download could not be queued' }, 502);
    }
  });

  return app;
}
