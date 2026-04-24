import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import type { ProviderRegistry } from '../services/provider-registry.js';
import type { BrowseDirectory } from '@nicotind/core';
import { BrowseUnavailableError } from '@nicotind/core';

// ─── In-memory job store ─────────────────────────────────────────────
type BrowseJob =
  | { state: 'pending'; startedAt: number }
  | { state: 'complete'; dirs: BrowseDirectory[]; startedAt: number }
  | { state: 'error'; error: string; startedAt: number };

const browseJobs = new Map<string, BrowseJob>();

// Prune jobs older than 10 minutes to prevent unbounded memory growth
const JOB_TTL_MS = 10 * 60 * 1000;
function pruneOldJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of browseJobs) {
    if (job.startedAt < cutoff) browseJobs.delete(id);
  }
}

export function usersRoutes(registry: ProviderRegistry) {
  const app = new Hono<AuthEnv>();

  // Start a browse job — returns immediately with a jobId (202)
  app.get('/:username/browse', async (c) => {
    const username = c.req.param('username');

    const provider = registry.getBrowseProvider();
    if (!provider) {
      return c.json({ error: 'Browse not supported' }, 501);
    }

    pruneOldJobs();

    const jobId = crypto.randomUUID();
    const startedAt = Date.now();
    browseJobs.set(jobId, { state: 'pending', startedAt });

    // Fire browse in the background — do NOT await
    provider
      .browseUser(username)
      .then((dirs) => browseJobs.set(jobId, { state: 'complete', dirs, startedAt }))
      .catch((err) => {
        const error =
          err instanceof BrowseUnavailableError
            ? 'Browse provider not available'
            : err instanceof Error
              ? err.message
              : String(err);
        browseJobs.set(jobId, { state: 'error', error, startedAt });
      });

    return c.json({ jobId, state: 'pending' }, 202);
  });

  // Poll for browse result — returns 202 while pending, 200 when done
  app.get('/:username/browse/:jobId', async (c) => {
    const jobId = c.req.param('jobId');
    const job = browseJobs.get(jobId);

    if (!job) {
      return c.json({ error: 'Browse job not found' }, 404);
    }

    if (job.state === 'pending') {
      return c.json({ state: 'pending' }, 202);
    }

    // Remove from map once consumed
    browseJobs.delete(jobId);

    if (job.state === 'error') {
      return c.json({ state: 'error', error: job.error }, 200);
    }

    return c.json({ state: 'complete', dirs: job.dirs }, 200);
  });

  return app;
}
