import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AuthEnv } from '../middleware/auth.js';
import type { ProviderRegistry } from '../services/provider-registry.js';
import { RemoteAddonPlugin } from '../services/addons/remote-addon-plugin.js';
import type { PluginRegistry } from '../services/plugins/registry.js';
import { createLogger, type DownloadReceipt } from '@nicotind/core';
import { getDatabase } from '../db.js';
import { requireAcquirer } from '../middleware/current-user.js';
import {
  cancelUnownedJob,
  createJob,
  listJobFeed,
  resolveJobAlbumId,
} from '../services/acquisition-job-store.js';
import { mapAddonJob } from '../services/addons/job-poller.js';

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

export function downloadRoutes(registry: ProviderRegistry, pluginRegistry?: PluginRegistry) {
  const app = new OpenAPIHono<AuthEnv>();

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
          artistName: segments.length >= 2 ? segments[segments.length - 2] : null,
          albumTitle: segments.length >= 1 ? segments[segments.length - 1] : null,
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
    const addon = pluginRegistry?.get(ref.addonId);
    if (!(addon instanceof RemoteAddonPlugin)) {
      return c.json({ error: `Addon "${ref.addonId}" is not registered` }, 503);
    }
    try {
      await addon.client.cancelJob(ref.addonJobId);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'cancel failed' }, 502);
    }
    return c.json({ ok: true });
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
        await addon.client.deleteJob(ref.addonJobId).catch(() => {});
      }
    }
    db.run(`DELETE FROM acquisition_job_items WHERE job_id = ?`, [job.id]);
    db.run(`DELETE FROM acquisition_jobs WHERE id = ?`, [job.id]);
    return c.json({ ok: true });
  });

  return app;
}
