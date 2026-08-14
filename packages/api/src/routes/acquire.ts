import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { AuthEnv } from '../middleware/auth.js';
import { requireAcquirer } from '../middleware/current-user.js';
import {
  AcquireWatcher,
  NoAcquisitionPluginError,
  PluginUnavailableError,
} from '../services/acquire-watcher.js';
import type { PluginRegistry } from '../services/plugins/registry.js';
import { resolveAddonForUrl } from '../services/addons/resolve-router.js';
import { mapAddonJob } from '../services/addons/job-poller.js';
import { createJob } from '../services/acquisition-job-store.js';

interface SubmitBody {
  url: string;
  /**
   * Classifier override. `'playlist'` is honored for any URL the classifier
   * did NOT already recognize as a playlist (archive.org items — the web's
   * "Treat as playlist" toggle — and unrecognized custom links alike);
   * `'album'` downgrades a recognized playlist URL to a single-item acquire.
   * Spotify/YouTube playlist URLs auto-detect and need no override.
   */
  as?: 'playlist' | 'album';
}

/**
 * URL acquisition routes. Backend selection is no longer hardcoded — the watcher
 * routes the URL to whichever enabled `resolve`-capable plugin handles it
 * (`registry.getEnabledForUrl`). When none is enabled/available the submit
 * returns 503 so the UI can hide the acquire box.
 */
export function acquireRoutes(watcher: AcquireWatcher, registry: PluginRegistry, db: Database) {
  const app = new Hono<AuthEnv>();

  // Acquisition is hidden from listeners — gate the whole group server-side.
  app.use('*', async (c, next) => {
    requireAcquirer(c);
    await next();
  });

  app.post('/', async (c) => {
    let body: SubmitBody;
    try {
      body = await c.req.json<SubmitBody>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.url || typeof body.url !== 'string') {
      return c.json({ error: 'url is required' }, 400);
    }

    let url: URL;
    try {
      url = new URL(body.url);
    } catch {
      return c.json({ error: 'url must be a valid URL' }, 400);
    }

    // Prefer a resolve-capable addon (bundled archive, and later the external
    // yt-dlp/spotdl addons). The addon resolves in the background; we eagerly
    // mirror an `acquisition_jobs` row so the Downloads card appears in-flight
    // right away (fixing #509 cause 2), and map it so the poller reuses the row.
    const addon = resolveAddonForUrl(registry, url.href);
    if (addon) {
      try {
        const addonJob = await addon.client.createJob({
          intent: 'url',
          url: url.href,
          as: body.as,
        });
        const coreJobId = createJob(db, {
          kind: 'url',
          method: addon.addonManifest.id,
          sourceRef: `addon:${addon.addonManifest.id}:${addonJob.id}`,
          files: [],
        });
        mapAddonJob(db, addon.addonManifest.id, addonJob.id, coreJobId);
        return c.json({ jobId: coreJobId }, 201);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to start acquire job';
        return c.json({ error: message }, 500);
      }
    }

    try {
      // Fall back to an in-process resolve plugin (yt-dlp/spotdl until they
      // migrate). Thread the authenticated user id through so a playlist URL can
      // generate a per-user native playlist on completion.
      const jobId = await watcher.submit(url.href, undefined, {
        userId: c.var.user.sub,
        as: body.as,
      });
      return c.json({ jobId }, 201);
    } catch (err) {
      if (err instanceof NoAcquisitionPluginError || err instanceof PluginUnavailableError) {
        return c.json({ error: err.message }, 503);
      }
      const message = err instanceof Error ? err.message : 'Failed to start acquire job';
      return c.json({ error: message }, 500);
    }
  });

  app.get('/jobs', (c) => {
    const jobs = watcher.listJobs();
    return c.json(jobs);
  });

  app.get('/jobs/:id', (c) => {
    const job = watcher.getJob(c.req.param('id'));
    if (!job) return c.json({ error: 'Job not found' }, 404);
    return c.json(job);
  });

  app.delete('/jobs/:id', (c) => {
    const id = c.req.param('id');
    if (watcher.cancel(id)) return c.json({ ok: true });
    if (watcher.deleteJob(id)) return c.json({ ok: true });
    return c.json({ error: 'Job not found' }, 404);
  });

  app.post('/jobs/:id/retry', async (c) => {
    try {
      const newJobId = await watcher.retryJob(c.req.param('id'), {
        userId: c.var.user.sub,
      });
      if (!newJobId) return c.json({ error: 'Job not found' }, 404);
      return c.json({ jobId: newJobId }, 201);
    } catch (err) {
      if (err instanceof NoAcquisitionPluginError || err instanceof PluginUnavailableError) {
        return c.json({ error: err.message }, 503);
      }
      throw err;
    }
  });

  return app;
}
