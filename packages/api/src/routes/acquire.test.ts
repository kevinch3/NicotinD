import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';

// ─── AcquireWatcher mock ─────────────────────────────────────────────────────

interface MockJob {
  id: string;
  backend: string;
  url: string;
  label: string | null;
  state: string;
  progress: { done: number; total: number } | null;
  error: string | null;
  created_at: number;
}

function makeMockWatcher() {
  const jobs: MockJob[] = [];
  return {
    jobs,
    submitMock: mock(async (url: string, backend: string): Promise<string> => {
      const id = `job-${jobs.length + 1}`;
      jobs.push({ id, backend, url, label: null, state: 'queued', progress: null, error: null, created_at: Date.now() });
      return id;
    }),
    cancelMock: mock((jobId: string): boolean => {
      // Only succeeds for queued/running (not done/failed)
      const job = jobs.find(j => j.id === jobId);
      return job !== undefined && (job.state === 'queued' || job.state === 'running');
    }),
    deleteJobMock: mock((jobId: string): boolean => {
      const idx = jobs.findIndex(j => j.id === jobId && (j.state === 'done' || j.state === 'failed'));
      if (idx === -1) return false;
      jobs.splice(idx, 1);
      return true;
    }),
    retryJobMock: mock(async (jobId: string): Promise<string | null> => {
      const job = jobs.find(j => j.id === jobId);
      if (!job) return null;
      const newId = `job-${jobs.length + 1}-retry`;
      jobs.push({ ...job, id: newId, state: 'queued' });
      jobs.splice(jobs.indexOf(job), 1);
      return newId;
    }),
    ytdlpAvailable: true,
    spotdlAvailable: false,
    isYtdlpAvailable() { return this.ytdlpAvailable; },
    isSpotdlAvailable() { return this.spotdlAvailable; },
    submit(url: string, backend: string) { return this.submitMock(url, backend); },
    cancel(id: string) { return this.cancelMock(id); },
    deleteJob(id: string) { return this.deleteJobMock(id); },
    retryJob(id: string) { return this.retryJobMock(id); },
    getJob(id: string) { return jobs.find(j => j.id === id) ?? null; },
    listJobs() { return [...jobs]; },
  };
}

import { acquireRoutes } from './acquire.js';

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeApp(watcher: ReturnType<typeof makeMockWatcher>) {
  const app = new Hono<AuthEnv>();
  app.use('*', (c, next) => {
    c.set('user', { sub: 'user1', role: 'user', iat: 0, exp: 9999999999 });
    return next();
  });
  app.route('/', acquireRoutes(watcher as unknown as Parameters<typeof acquireRoutes>[0]));
  return app;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('acquire routes', () => {
  let watcher: ReturnType<typeof makeMockWatcher>;
  let app: Hono<AuthEnv>;

  beforeEach(() => {
    watcher = makeMockWatcher();
    app = makeApp(watcher);
  });

  describe('POST /', () => {
    it('returns 400 for missing url', async () => {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const json = await res.json() as { error: string };
      expect(json.error).toBeTruthy();
    });

    it('returns 400 for invalid url', async () => {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'not-a-url' }),
      });
      expect(res.status).toBe(400);
    });

    it('creates a job and returns 201 with jobId', async () => {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abc' }),
      });
      expect(res.status).toBe(201);
      const json = await res.json() as { jobId: string };
      expect(typeof json.jobId).toBe('string');
      expect(watcher.submitMock).toHaveBeenCalledTimes(1);
    });

    it('auto-detects ytdlp backend for youtube urls', async () => {
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abc' }),
      });
      const [, backend] = watcher.submitMock.mock.calls[0] as [string, string];
      expect(backend).toBe('ytdlp');
    });

    it('auto-detects spotdl backend for spotify urls', async () => {
      watcher.spotdlAvailable = true;
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://open.spotify.com/playlist/abc' }),
      });
      const [, backend] = watcher.submitMock.mock.calls[0] as [string, string];
      expect(backend).toBe('spotdl');
    });

    it('returns 503 when ytdlp is unavailable', async () => {
      watcher.ytdlpAvailable = false;
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abc' }),
      });
      expect(res.status).toBe(503);
    });

    it('returns 503 when spotdl is unavailable', async () => {
      watcher.spotdlAvailable = false;
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://open.spotify.com/album/xyz', backend: 'spotdl' }),
      });
      expect(res.status).toBe(503);
    });

    it('accepts explicit backend override', async () => {
      watcher.spotdlAvailable = true;
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abc', backend: 'spotdl' }),
      });
      const [, backend] = watcher.submitMock.mock.calls[0] as [string, string];
      expect(backend).toBe('spotdl');
    });
  });

  describe('GET /jobs', () => {
    it('returns empty array when no jobs', async () => {
      const res = await app.request('/jobs');
      expect(res.status).toBe(200);
      const jobs = await res.json() as unknown[];
      expect(Array.isArray(jobs)).toBe(true);
      expect(jobs.length).toBe(0);
    });

    it('returns all jobs after submit', async () => {
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abc' }),
      });
      const res = await app.request('/jobs');
      const jobs = await res.json() as unknown[];
      expect(jobs.length).toBe(1);
    });
  });

  describe('GET /jobs/:id', () => {
    it('returns 404 for unknown job', async () => {
      const res = await app.request('/jobs/nonexistent');
      expect(res.status).toBe(404);
    });

    it('returns job details for known job', async () => {
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abc' }),
      });
      const jobId = watcher.jobs[0]!.id;
      const res = await app.request(`/jobs/${jobId}`);
      expect(res.status).toBe(200);
      const job = await res.json() as { id: string; state: string };
      expect(job.id).toBe(jobId);
      expect(job.state).toBe('queued');
    });
  });

  describe('DELETE /jobs/:id', () => {
    it('returns 404 for unknown job', async () => {
      const res = await app.request('/jobs/nonexistent', { method: 'DELETE' });
      expect(res.status).toBe(404);
    });

    it('cancels a queued job via cancel()', async () => {
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abc' }),
      });
      const jobId = watcher.jobs[0]!.id;
      const res = await app.request(`/jobs/${jobId}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      const json = await res.json() as { ok: boolean };
      expect(json.ok).toBe(true);
      expect(watcher.cancelMock).toHaveBeenCalledWith(jobId);
    });

    it('deletes a done job via deleteJob() when cancel() returns false', async () => {
      // Manually push a done job
      watcher.jobs.push({ id: 'done-job', backend: 'ytdlp', url: 'https://example.com', label: null, state: 'done', progress: null, error: null, created_at: Date.now() });
      const res = await app.request('/jobs/done-job', { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(watcher.deleteJobMock).toHaveBeenCalledWith('done-job');
    });

    it('deletes a failed job via deleteJob()', async () => {
      watcher.jobs.push({ id: 'failed-job', backend: 'ytdlp', url: 'https://example.com', label: null, state: 'failed', progress: null, error: 'oops', created_at: Date.now() });
      const res = await app.request('/jobs/failed-job', { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(watcher.deleteJobMock).toHaveBeenCalledWith('failed-job');
    });
  });

  describe('POST /jobs/:id/retry', () => {
    it('returns 404 for unknown job', async () => {
      const res = await app.request('/jobs/nonexistent/retry', { method: 'POST' });
      expect(res.status).toBe(404);
    });

    it('retries a failed job and returns new jobId', async () => {
      watcher.jobs.push({ id: 'failed-job', backend: 'ytdlp', url: 'https://www.youtube.com/watch?v=abc', label: null, state: 'failed', progress: null, error: 'oops', created_at: Date.now() });
      const res = await app.request('/jobs/failed-job/retry', { method: 'POST' });
      expect(res.status).toBe(201);
      const json = await res.json() as { jobId: string };
      expect(typeof json.jobId).toBe('string');
      expect(json.jobId).not.toBe('failed-job');
      expect(watcher.retryJobMock).toHaveBeenCalledWith('failed-job');
    });
  });
});
