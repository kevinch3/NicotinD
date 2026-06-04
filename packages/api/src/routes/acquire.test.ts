import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import {
  acquireRoutes,
} from './acquire.js';
import {
  NoAcquisitionPluginError,
  PluginUnavailableError,
  type AcquireWatcher,
} from '../services/acquire-watcher.js';

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

// Submit routes by URL now: special hosts simulate the watcher's 503 errors.
function makeMockWatcher() {
  const jobs: MockJob[] = [];
  return {
    jobs,
    submitMock: mock(async (url: string): Promise<string> => {
      if (url.includes('unhandled')) throw new NoAcquisitionPluginError(url);
      if (url.includes('unavailable')) throw new PluginUnavailableError('ytdlp');
      const id = `job-${jobs.length + 1}`;
      jobs.push({ id, backend: 'ytdlp', url, label: null, state: 'queued', progress: null, error: null, created_at: Date.now() });
      return id;
    }),
    cancelMock: mock((jobId: string): boolean => {
      const job = jobs.find((j) => j.id === jobId);
      return job !== undefined && (job.state === 'queued' || job.state === 'running');
    }),
    deleteJobMock: mock((jobId: string): boolean => {
      const idx = jobs.findIndex((j) => j.id === jobId && (j.state === 'done' || j.state === 'failed'));
      if (idx === -1) return false;
      jobs.splice(idx, 1);
      return true;
    }),
    retryJobMock: mock(async (jobId: string): Promise<string | null> => {
      const job = jobs.find((j) => j.id === jobId);
      if (!job) return null;
      const newId = `${jobId}-retry`;
      jobs.push({ ...job, id: newId, state: 'queued' });
      jobs.splice(jobs.indexOf(job), 1);
      return newId;
    }),
    submit(url: string) {
      return this.submitMock(url);
    },
    cancel(id: string) {
      return this.cancelMock(id);
    },
    deleteJob(id: string) {
      return this.deleteJobMock(id);
    },
    retryJob(id: string) {
      return this.retryJobMock(id);
    },
    getJob(id: string) {
      return jobs.find((j) => j.id === id) ?? null;
    },
    listJobs() {
      return [...jobs];
    },
  };
}

function makeApp(watcher: ReturnType<typeof makeMockWatcher>) {
  const app = new Hono<AuthEnv>();
  app.use('*', (c, next) => {
    c.set('user', { sub: 'user1', role: 'user', iat: 0, exp: 9999999999 });
    return next();
  });
  app.route('/', acquireRoutes(watcher as unknown as AcquireWatcher));
  return app;
}

function post(app: Hono<AuthEnv>, url: string) {
  return app.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
}

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
    });

    it('returns 400 for invalid url', async () => {
      const res = await post(app, 'not-a-url');
      expect(res.status).toBe(400);
    });

    it('creates a job and returns 201 with jobId', async () => {
      const res = await post(app, 'https://www.youtube.com/watch?v=abc');
      expect(res.status).toBe(201);
      const json = (await res.json()) as { jobId: string };
      expect(typeof json.jobId).toBe('string');
      expect(watcher.submitMock).toHaveBeenCalledTimes(1);
    });

    it('returns 503 when no enabled plugin handles the URL', async () => {
      const res = await post(app, 'https://unhandled.example/x');
      expect(res.status).toBe(503);
    });

    it('returns 503 when the chosen plugin is unavailable', async () => {
      const res = await post(app, 'https://unavailable.example/x');
      expect(res.status).toBe(503);
    });
  });

  describe('GET /jobs', () => {
    it('returns empty array when no jobs', async () => {
      const res = await app.request('/jobs');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it('returns all jobs after submit', async () => {
      await post(app, 'https://www.youtube.com/watch?v=abc');
      const res = await app.request('/jobs');
      expect((await res.json()) as unknown[]).toHaveLength(1);
    });
  });

  describe('GET /jobs/:id', () => {
    it('returns 404 for unknown job', async () => {
      const res = await app.request('/jobs/nonexistent');
      expect(res.status).toBe(404);
    });

    it('returns job details for known job', async () => {
      await post(app, 'https://www.youtube.com/watch?v=abc');
      const jobId = watcher.jobs[0]!.id;
      const res = await app.request(`/jobs/${jobId}`);
      expect(res.status).toBe(200);
      const job = (await res.json()) as { id: string };
      expect(job.id).toBe(jobId);
    });
  });

  describe('DELETE /jobs/:id', () => {
    it('returns 404 for unknown job', async () => {
      const res = await app.request('/jobs/nonexistent', { method: 'DELETE' });
      expect(res.status).toBe(404);
    });

    it('cancels a queued job via cancel()', async () => {
      await post(app, 'https://www.youtube.com/watch?v=abc');
      const jobId = watcher.jobs[0]!.id;
      const res = await app.request(`/jobs/${jobId}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(watcher.cancelMock).toHaveBeenCalledWith(jobId);
    });

    it('deletes a done job via deleteJob() when cancel() returns false', async () => {
      watcher.jobs.push({ id: 'done-job', backend: 'ytdlp', url: 'https://example.com', label: null, state: 'done', progress: null, error: null, created_at: Date.now() });
      const res = await app.request('/jobs/done-job', { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(watcher.deleteJobMock).toHaveBeenCalledWith('done-job');
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
      const json = (await res.json()) as { jobId: string };
      expect(json.jobId).not.toBe('failed-job');
      expect(watcher.retryJobMock).toHaveBeenCalledWith('failed-job');
    });
  });
});
