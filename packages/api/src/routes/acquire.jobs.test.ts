import { describe, expect, it, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import type { AuthEnv } from '../middleware/auth.js';
import { PluginRegistry } from '../services/plugins/registry.js';
import { RemoteAddonPlugin } from '../services/addons/remote-addon-plugin.js';
import { LocalAddonTransport } from '../services/addons/local-transport.js';
import type { BundledAddon } from '../services/addons/bundled/types.js';
import { acquireRoutes } from './acquire.js';
import type { AcquireWatcher } from '../services/acquire-watcher.js';
import type { AcquireJob, AddonJob } from '@nicotind/core';

interface StubAddon extends BundledAddon {
  createCalls: Array<{ url: string; idempotencyKey?: string }>;
}

function stubResolveAddon(): StubAddon {
  const createCalls: Array<{ url: string; idempotencyKey?: string }> = [];
  let seq = 0;
  const job = (id: string): AddonJob => ({
    id,
    intent: 'url',
    artist: null,
    album: null,
    state: 'active',
    error: null,
    items: [],
    createdAt: 0,
    updatedAt: 0,
  });
  return {
    createCalls,
    manifest: {
      id: 'bundled-stub',
      name: 'Stub',
      description: 'test resolve addon',
      version: '1.0.0',
      protocolVersion: '1.0.0',
      kind: 'acquisition',
      capabilities: ['resolve'],
      urlPatterns: ['^https?://stub\\.test/'],
      compliance: { disclaimer: 'test', requiresConsent: false },
    },
    createJob: async (req, idempotencyKey) => {
      createCalls.push({ url: String(req.url), idempotencyKey });
      return job(`addon-job-${++seq}`);
    },
    getJob: async () => {
      throw new Error('not used');
    },
    listJobs: async () => [],
    cancelJob: async () => {},
    deleteJob: async () => {},
    filePath: async () => '/tmp/x',
  };
}

describe('acquire route — addon seam', () => {
  let db: Database;
  let registry: PluginRegistry;
  let watcherCalls: string[];
  let addon: StubAddon;

  beforeEach(async () => {
    db = new Database(':memory:');
    applySchema(db);
    registry = new PluginRegistry({ db, dataDir: '/tmp/nic-acqjobs' });
    addon = stubResolveAddon();
    registry.register(new RemoteAddonPlugin(addon.manifest, new LocalAddonTransport(addon)));
    await registry.enable('bundled-stub', 'u');
    watcherCalls = [];
  });

  function makeApp(): Hono<AuthEnv> {
    const watcher = {
      submit: async (url: string) => {
        watcherCalls.push(url);
        return 'watcher-job';
      },
      listJobs: () => [],
      getJob: () => null,
      cancel: () => false,
      deleteJob: () => false,
      retryJob: async () => null,
    } as unknown as AcquireWatcher;
    const app = new Hono<AuthEnv>();
    app.use('*', (c, next) => {
      c.set('user', { sub: 'u', role: 'admin', iat: 0, exp: 9999999999 });
      return next();
    });
    app.route('/', acquireRoutes(watcher, registry, db));
    return app;
  }

  function post(app: Hono<AuthEnv>, url: string) {
    return app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
  }

  it('routes a matching url to the addon and eagerly mirrors a kind:url job at submit', async () => {
    const res = await post(makeApp(), 'https://stub.test/track');
    expect(res.status).toBe(201);
    const { jobId } = (await res.json()) as { jobId: string };
    const row = db
      .query<{ kind: string; method: string; source_ref: string; source_url: string }, [string]>(
        'SELECT kind, method, source_ref, source_url FROM acquisition_jobs WHERE id = ?',
      )
      .get(jobId);
    expect(row?.kind).toBe('url');
    expect(row?.method).toBe('bundled-stub');
    expect(row?.source_ref).toBe('addon:bundled-stub:addon-job-1');
    // The pasted link is recorded on the job — that's what makes a re-paste
    // recognisable as "already downloading".
    expect(row?.source_url).toBe('https://stub.test/track');
    expect(watcherCalls).toHaveLength(0); // the addon handled it, not the watcher
  });

  it('falls back to the in-process watcher for a url no addon matches', async () => {
    const res = await post(makeApp(), 'https://youtube.com/watch?v=x');
    expect(res.status).toBe(201);
    const { jobId } = (await res.json()) as { jobId: string };
    expect(jobId).toBe('watcher-job');
    expect(watcherCalls).toEqual(['https://youtube.com/watch?v=x']);
  });

  describe('one link = one download (idempotent submit)', () => {
    it('re-submitting an in-flight url reuses the job instead of starting a second download', async () => {
      const app = makeApp();
      const first = await post(app, 'https://stub.test/track');
      const second = await post(app, 'https://stub.test/track');

      expect(first.status).toBe(201);
      expect(second.status).toBe(200); // 200, not 201 — nothing new was created
      const a = (await first.json()) as { jobId: string; reused: boolean };
      const b = (await second.json()) as { jobId: string; reused: boolean };
      expect(b.jobId).toBe(a.jobId);
      expect(a.reused).toBe(false);
      expect(b.reused).toBe(true);

      // Neither the addon nor the feed saw a second job.
      expect(addon.createCalls).toHaveLength(1);
      const count = db.query<{ c: number }, []>(`SELECT COUNT(*) c FROM acquisition_jobs`).get()!.c;
      expect(count).toBe(1);
    });

    it('passes a url-derived Idempotency-Key so the addon can dedupe too', async () => {
      await post(makeApp(), 'https://stub.test/track');
      expect(addon.createCalls[0]?.idempotencyKey).toBe('url:https://stub.test/track');
    });

    it('does not block a fresh submit once the previous job is terminal', async () => {
      const app = makeApp();
      const first = await post(app, 'https://stub.test/track');
      const { jobId } = (await first.json()) as { jobId: string };
      db.run(`UPDATE acquisition_jobs SET state = 'done', stage = 'done' WHERE id = ?`, [jobId]);

      const second = await post(app, 'https://stub.test/track');
      expect(second.status).toBe(201);
      expect(((await second.json()) as { jobId: string }).jobId).not.toBe(jobId);
      expect(addon.createCalls).toHaveLength(2);
    });

    it('dedupes per url — a different link still starts its own job', async () => {
      const app = makeApp();
      await post(app, 'https://stub.test/a');
      await post(app, 'https://stub.test/b');
      expect(addon.createCalls).toHaveLength(2);
    });
  });

  describe('GET /jobs', () => {
    it('lists addon-run url jobs alongside the in-process ones, keyed on the pasted url', async () => {
      const app = makeApp();
      await post(app, 'https://stub.test/track');
      const res = await app.request('/jobs');
      expect(res.status).toBe(200);
      const jobs = (await res.json()) as AcquireJob[];
      expect(jobs).toHaveLength(1);
      // The web's link card finds its job by matching this url — an addon job
      // missing here reads as "nothing happened" and invites another click.
      expect(jobs[0]!.url).toBe('https://stub.test/track');
      expect(jobs[0]!.backend).toBe('bundled-stub');
      // 'queued', not 'running': the addon resolves in the background and has
      // not fetched a byte at submit time. The row used to take the column
      // default (`downloading`), which rendered "Downloading 0 of 0" — for a
      // link the addon cannot handle, forever (the beatport report).
      expect(jobs[0]!.state).toBe('queued');
      expect(jobs[0]!.stage).toBe('queued');
    });

    it('GET /jobs/:id resolves an addon-run url job', async () => {
      const app = makeApp();
      const { jobId } = (await (await post(app, 'https://stub.test/track')).json()) as {
        jobId: string;
      };
      const res = await app.request(`/jobs/${jobId}`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as AcquireJob).id).toBe(jobId);
    });
  });

  it('DELETE /jobs/:id removes an addon-run url job the watcher does not own', async () => {
    const app = makeApp();
    const { jobId } = (await (await post(app, 'https://stub.test/track')).json()) as {
      jobId: string;
    };
    const res = await app.request(`/jobs/${jobId}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(db.query<{ c: number }, []>(`SELECT COUNT(*) c FROM acquisition_jobs`).get()!.c).toBe(0);
  });

  it('POST /jobs/:id/retry re-submits the stored url for an addon-run job', async () => {
    const app = makeApp();
    const { jobId } = (await (await post(app, 'https://stub.test/track')).json()) as {
      jobId: string;
    };
    db.run(`UPDATE acquisition_jobs SET state = 'failed', stage = 'error' WHERE id = ?`, [jobId]);
    const res = await app.request(`/jobs/${jobId}/retry`, { method: 'POST' });
    expect(res.status).toBe(201);
    expect(addon.createCalls).toHaveLength(2);
    expect(addon.createCalls[1]?.url).toBe('https://stub.test/track');
  });
});
