import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import type { AcquireWatcher } from '../services/acquire-watcher.js';
import type { AcquireBackend } from '../services/ytdlp.service.js';

function detectBackend(url: string): AcquireBackend {
  return url.includes('spotify.com') ? 'spotdl' : 'ytdlp';
}

interface SubmitBody {
  url: string;
  backend?: AcquireBackend;
}

export function acquireRoutes(watcher: AcquireWatcher) {
  const app = new Hono<AuthEnv>();

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

    const resolvedBackend = body.backend ?? detectBackend(url.href);

    if (resolvedBackend === 'spotdl' && !watcher.isSpotdlAvailable()) {
      return c.json({ error: 'spotdl is not installed or not enabled' }, 503);
    }
    if (resolvedBackend === 'ytdlp' && !watcher.isYtdlpAvailable()) {
      return c.json({ error: 'yt-dlp is not installed or not enabled' }, 503);
    }

    try {
      const jobId = await watcher.submit(url.href, resolvedBackend);
      return c.json({ jobId }, 201);
    } catch (err) {
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
    const newJobId = await watcher.retryJob(c.req.param('id'));
    if (!newJobId) return c.json({ error: 'Job not found' }, 404);
    return c.json({ jobId: newJobId }, 201);
  });

  return app;
}
