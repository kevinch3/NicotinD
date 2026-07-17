import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { requireAcquirer } from '../middleware/current-user.js';
import {
  AcquireWatcher,
  NoAcquisitionPluginError,
  PluginUnavailableError,
} from '../services/acquire-watcher.js';

interface SubmitBody {
  url: string;
}

/**
 * URL acquisition routes. Backend selection is no longer hardcoded — the watcher
 * routes the URL to whichever enabled `resolve`-capable plugin handles it
 * (`registry.getEnabledForUrl`). When none is enabled/available the submit
 * returns 503 so the UI can hide the acquire box.
 */
export function acquireRoutes(watcher: AcquireWatcher) {
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

    try {
      const jobId = await watcher.submit(url.href);
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
      const newJobId = await watcher.retryJob(c.req.param('id'));
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
