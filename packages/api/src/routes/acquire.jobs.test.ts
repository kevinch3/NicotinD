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

function stubResolveAddon(): BundledAddon {
  return {
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
    createJob: async () => ({
      id: 'addon-job-1',
      intent: 'url',
      artist: null,
      album: null,
      state: 'active',
      error: null,
      items: [],
      createdAt: 0,
      updatedAt: 0,
    }),
    getJob: async () => {
      throw new Error('not used');
    },
    listJobs: async () => [],
    cancelJob: async () => {},
    filePath: async () => '/tmp/x',
  };
}

describe('acquire route — addon seam', () => {
  let db: Database;
  let registry: PluginRegistry;
  let watcherCalls: string[];

  beforeEach(async () => {
    db = new Database(':memory:');
    applySchema(db);
    registry = new PluginRegistry({ db, dataDir: '/tmp/nic-acqjobs' });
    registry.register(
      new RemoteAddonPlugin(
        stubResolveAddon().manifest,
        new LocalAddonTransport(stubResolveAddon()),
      ),
    );
    await registry.enable('bundled-stub', 'u');
    watcherCalls = [];
  });

  function makeApp(): Hono<AuthEnv> {
    const watcher = {
      submit: async (url: string) => {
        watcherCalls.push(url);
        return 'watcher-job';
      },
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
      .query<{ kind: string; method: string; source_ref: string }, [string]>(
        'SELECT kind, method, source_ref FROM acquisition_jobs WHERE id = ?',
      )
      .get(jobId);
    expect(row?.kind).toBe('url');
    expect(row?.method).toBe('bundled-stub');
    expect(row?.source_ref).toBe('addon:bundled-stub:addon-job-1');
    expect(watcherCalls).toHaveLength(0); // the addon handled it, not the watcher
  });

  it('falls back to the in-process watcher for a url no addon matches', async () => {
    const res = await post(makeApp(), 'https://youtube.com/watch?v=x');
    expect(res.status).toBe(201);
    const { jobId } = (await res.json()) as { jobId: string };
    expect(jobId).toBe('watcher-job');
    expect(watcherCalls).toEqual(['https://youtube.com/watch?v=x']);
  });
});
