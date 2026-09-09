import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import type { ProviderRegistry } from '../services/provider-registry.js';
import { RemoteAddonPlugin } from '../services/addons/remote-addon-plugin.js';
import type { PluginRegistry } from '../services/plugins/registry.js';
import { createLogger, isGenericFolderName, type DownloadReceipt } from '@nicotind/core';
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
  activePeers,
  canResourceJob,
  claimUnattributedItems,
  huntTracklist,
  getJob,
  resourceableTitles,
  supersedeItems,
} from '../services/acquisition-job-store.js';
import { rankAlternates } from '../services/download-resource.js';
import { mapAddonJob } from '../services/addons/job-poller.js';
import { AddonRequestError } from '../services/addons/client.js';
import { deleteSongs } from '../services/library-deletion.js';
import { errorHandler } from '../middleware/error-handler.js';
import { recordAudit } from '../services/audit-log.js';
import type { ShareRescanScheduler } from '../services/share-rescan-scheduler.js';

const log = createLogger('downloads');

const DownloadFileSchema = z.object({
  filename: z.string(),
  size: z.number(),
});

const EnqueueDownloadRequestSchema = z.object({
  username: z.string().min(1).openapi({ example: 'slsk_user' }),
  files: z.array(DownloadFileSchema).min(1),
});

const DownloadResponseSchema = z
  .object({
    ok: z.boolean(),
    queued: z.number(),
  })
  .openapi('DownloadResponse');

const ErrorSchema = z
  .object({
    error: z.string(),
  })
  .openapi('Error');

/** Parse a `addon:<id>:<jobId>` sourceRef, if that's what it is. */
function parseAddonRef(sourceRef: string | null): { addonId: string; addonJobId: string } | null {
  if (!sourceRef?.startsWith('addon:')) return null;
  const rest = sourceRef.slice('addon:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  return { addonId: rest.slice(0, sep), addonJobId: rest.slice(sep + 1) };
}

export interface DownloadDiscardDeps {
  musicDir?: string;
  shareRescan: ShareRescanScheduler;
}

export function downloadRoutes(
  registry: ProviderRegistry,
  pluginRegistry?: PluginRegistry,
  discardDeps?: DownloadDiscardDeps,
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
      const { username, files } = c.req.valid('json');

      const networkProviders = registry.getByType('network');
      const provider = networkProviders[0];

      if (!provider?.download) {
        return c.json({ error: 'No download provider available' }, 503);
      }

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
      try {
        const segments = (files[0]?.filename ?? '')
          .replace(/\\/g, '/')
          .split('/')
          .filter(Boolean)
          .slice(0, -1); // drop the file basename
        // A generic segment ("complete", "FLAC") stores NULL, not the junk:
        // NULL self-heals via the poller's COALESCE backfill from the addon's
        // metadata; a junk hint blocks that backfill forever (#674).
        const hintFor = (segment: string | undefined): string | null =>
          segment && !isGenericFolderName(segment) ? segment : null;
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
          artistName: hintFor(segments.length >= 2 ? segments[segments.length - 2] : undefined),
          albumTitle: hintFor(segments[segments.length - 1]),
          sourceRef: addonJobId ? `addon:${provider.name}:${addonJobId}` : username,
          username,
          files,
        });
        if (addonJobId) mapAddonJob(db, provider.name, addonJobId, coreJobId);
      } catch (err) {
        log.warn({ username, err }, 'Failed to record acquisition job for direct download');
      }
      return c.json({ ok: true, queued: files.length }, 201);
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
    try {
      await addon.client.cancelJob(ref.addonJobId);
    } catch (err) {
      log.warn({ jobId: job.id, err }, 'addon cancel failed; grace valve will close the job');
      return c.json({ ok: true, addonNotified: false });
    }
    return c.json({ ok: true });
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
    const job = id ? getJob(db, id) : null;
    if (!job) return { error: c.json({ error: 'Job not found' }, 404) } as const;
    const row = db
      .query<{ cancel_requested_at: number | null; user_id: string | null }, [string]>(
        `SELECT cancel_requested_at, user_id FROM acquisition_jobs WHERE id = ?`,
      )
      .get(job.id);
    // Same gate as discard-partial: re-sourcing your own download is not
    // curation (docs/roles.md), and a NULL-owner row stays curator-only.
    const user = getCurrentUser(c);
    const isOwner = row?.user_id != null && row.user_id === user.sub;
    if (!isOwner && !canCurate(asRole(user.role))) {
      throw new ForbiddenError("Requires curator role, or the job's own user");
    }
    const facts = {
      kind: job.kind,
      artistName: job.artistName,
      albumTitle: job.albumTitle,
      canonicalTracks: job.canonicalTracks,
      cancelRequestedAt: row?.cancel_requested_at ?? null,
      items: job.items,
    };
    if (!canResourceJob(facts)) {
      return {
        error: c.json({ error: 'This download cannot be re-sourced from another peer' }, 400),
      } as const;
    }
    const ref = parseAddonRef(job.sourceRef);
    if (!ref || ref.addonId !== job.method) {
      return { error: c.json({ error: 'No acquisition addon owns this download' }, 400) } as const;
    }
    const addon = pluginRegistry?.get(ref.addonId);
    if (!(addon instanceof RemoteAddonPlugin)) {
      return { error: c.json({ error: 'The acquisition addon is not available' }, 503) } as const;
    }
    return { job, ref, addon, user, tracklist: huntTracklist(facts) } as const;
  }

  /**
   * Which other peers have the tracks this job is stuck on. Re-runs the hunt
   * and subtracts the peers already on the card — an "alternate" that is the
   * peer we are already waiting on is the same dead end.
   */
  app.post('/jobs/:id/resource/search', async (c) => {
    const db = getDatabase();
    const found = resourceableJob(c, db);
    if ('error' in found) return found.error;
    const { job, addon } = found;

    const body = await c.req
      .json<{ require?: string[] }>()
      .catch(() => ({}) as { require?: string[] });
    // Coverage is always measured over EVERYTHING still pending, because that
    // is what the chosen peer will be asked for: re-sourcing releases the stuck
    // job, so there is no second source left to split the remainder with
    // (#1069). A narrower `wanted` here would quietly shrink the request.
    const wanted = resourceableTitles(db, job.id);
    if (!wanted.length) return c.json({ error: 'Nothing on this download is still pending' }, 400);
    // Ticked tracks are a REQUIREMENT, not a narrowing: "only offer peers that
    // have these". Intersected with what is pending right now, so a track
    // delivered since the tick cannot rule out every peer.
    const required = (body.require ?? []).filter((t) => wanted.includes(t));

    const res = await addon.client.albumsSearch({
      artist: job.artistName ?? '',
      album: job.albumTitle ?? '',
      canonicalTracks: found.tracklist.map((title) => ({ title })),
    });
    const ranked = rankAlternates(wanted, res.candidates, activePeers(db, job.id));
    return c.json({
      wanted,
      required,
      alternates: required.length
        ? ranked.filter((a) => required.every((t) => a.coveredTitles.includes(t)))
        : ranked,
      // An empty list means something different in each of these cases, and the
      // picker says so: throttled and offline are both "we could not look
      // properly", not "nobody has it" (#1040, #1045).
      rateLimited: res.rateLimited ?? false,
      sourceOffline: res.sourceOffline ?? false,
    });
  });

  /**
   * Hand the named titles to the chosen peer. The new addon job is mapped onto
   * THIS core job, so its items mirror into the same card rather than opening a
   * second one — the download the user started is still the download they are
   * watching.
   */
  app.post('/jobs/:id/resource', async (c) => {
    const db = getDatabase();
    const found = resourceableJob(c, db);
    if ('error' in found) return found.error;
    const { job, ref, addon, user } = found;

    const body = await c.req
      .json<{ candidateRef?: string; titles?: string[] }>()
      .catch(() => ({}) as { candidateRef?: string; titles?: string[] });
    if (!body.candidateRef) return c.json({ error: 'Pick a peer first' }, 400);
    const available = resourceableTitles(db, job.id);
    // Intersected with what is pending RIGHT NOW: the picker's list was built
    // from a search that took tens of seconds, and a track delivered in the
    // meantime must not be taken away from the peer that delivered it.
    const titles = body.titles?.length
      ? body.titles.filter((t) => available.includes(t))
      : available;
    if (!titles.length) return c.json({ error: 'Nothing on this download is still pending' }, 400);

    // Attribute the existing rows BEFORE a second addon job can report, so the
    // terminal sweeps can tell the two apart (see OWNED_BY_ADDON_JOB).
    claimUnattributedItems(db, job.id, ref.addonJobId);

    // Release the stuck job FIRST (#1069). An addon may allow only one active
    // job per release — slskd does, and answers a second one with 409 — so
    // creating before cancelling made every re-source fail against the real
    // addon while passing against a more permissive test double. Cancelling
    // does not delete what already landed (only `deleteJob` does); it ends the
    // transfers that were not moving, which is the situation being fixed.
    //
    // This is why the new peer takes ALL of what is still pending rather than
    // only a ticked subset: once the old job is gone there is no second source
    // left to split with, so a split would just be a slower way to lose tracks.
    await addon.client.cancelJob(ref.addonJobId).catch((err: unknown) => {
      log.warn({ jobId: job.id, err }, 're-source: cancelling the stuck addon job failed');
    });

    let addonJobId: string;
    try {
      const created = await addon.client.createJob({
        intent: 'album',
        artist: job.artistName ?? undefined,
        album: job.albumTitle ?? undefined,
        canonicalTracks: found.tracklist.map((title) => ({ title })),
        // The whole point: this peer is asked for the missing titles only, not
        // for the folder again.
        wantedTracks: titles.map((title) => ({ title })),
        candidateRef: body.candidateRef,
      });
      addonJobId = created.id;
    } catch (err) {
      // Past the cancel, so the stuck job is gone either way and its items will
      // settle as `unavailable`. Say which failure this was: only an expired
      // selection is fixed by searching again, and telling someone to re-run a
      // 45 s hunt against a source that is refusing the job is worse than
      // saying nothing.
      log.warn({ jobId: job.id, err }, 're-source rejected by the addon');
      recomputeStage(db, job.id);
      const status = err instanceof AddonRequestError ? err.status : null;
      if (status === 409) {
        return c.json(
          {
            error: 'The source is still holding this album. Give it a moment and try again.',
            code: 'resource_conflict',
          },
          409,
        );
      }
      return c.json(
        { error: 'Selection expired — run the search again', code: 'resource_expired' },
        400,
      );
    }

    mapAddonJob(db, ref.addonId, addonJobId, job.id);
    supersedeItems(db, job.id, titles);
    recomputeStage(db, job.id);
    recordAudit(db, user, 'download.resource', {
      targetKind: 'acquisition_job',
      targetId: job.id,
      detail: `re-sourced ${titles.length} track(s) to a new peer (addon job ${addonJobId})`,
    });
    return c.json({ ok: true, resourced: titles.length, addonJobId });
  });

  app.delete('/jobs/:id', async (c) => {
    const db = getDatabase();
    const job = db
      .query<{ id: string; method: string; source_ref: string | null }, [string]>(
        `SELECT id, method, source_ref FROM acquisition_jobs WHERE id = ?`,
      )
      .get(c.req.param('id'));
    if (!job) return c.json({ error: 'Job not found' }, 404);
    // The feed row is core-owned and always deletable (issue #533 — legacy
    // peer-ref rows and url mirrors used to 400 here, pointing at per-transfer
    // routes that no longer exist, so Remove silently no-opped). The addon
    // half is best-effort and only applies when the ref actually names one.
    const ref = parseAddonRef(job.source_ref);
    if (ref && ref.addonId === job.method) {
      const addon = pluginRegistry?.get(ref.addonId);
      if (addon instanceof RemoteAddonPlugin) {
        await addon.client.cancelJob(ref.addonJobId).catch(() => {});
        // Releasing the job makes the addon delete its downloaded files
        // (NicotinD#1052), and the rows below are gone in this same request, so
        // the stranded sweep could never recover them. Discarding is exactly
        // what Remove means, so this is right — but say so out loud, because
        // any still-landing bytes die here and nowhere else records it.
        const pending = pendingIngestCount(db, job.id);
        if (pending > 0) {
          log.info(
            { jobId: job.id, addonJobId: ref.addonJobId, pending },
            'remove: discarding files that had not landed yet',
          );
        }
        await addon.client.deleteJob(ref.addonJobId).catch(() => {});
      }
    }
    db.run(`DELETE FROM acquisition_job_items WHERE job_id = ?`, [job.id]);
    db.run(`DELETE FROM acquisition_jobs WHERE id = ?`, [job.id]);
    return c.json({ ok: true });
  });

  return app;
}
